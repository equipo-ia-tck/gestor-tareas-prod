import { nameKey } from './text.ts';
import type { Project } from './types';

/** Niveles máximos de anidación (proyecto › subproyecto › sub-subproyecto). */
export const MAX_PROJECT_DEPTH = 3;

export interface ProjectNode {
  project: Project;
  depth: number;
  children: ProjectNode[];
}

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name, 'es');

/** Árbol de proyectos (los huérfanos, cuyo padre no existe, cuelgan de la raíz). */
export function projectTree(projects: Project[]): ProjectNode[] {
  const ids = new Set(projects.map((p) => p.id));
  const build = (parent: string | null, depth: number): ProjectNode[] =>
    projects
      .filter((p) => (parent === null ? !p.parent_id || !ids.has(p.parent_id) : p.parent_id === parent))
      .sort(byName)
      .map((project) => ({ project, depth, children: depth + 1 < 10 ? build(project.id, depth + 1) : [] }));
  return build(null, 0);
}

/** Árbol aplanado en orden de visualización (para listas y desplegables con sangría). */
export function flattenTree(nodes: ProjectNode[]): ProjectNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/** El propio proyecto y todos sus descendientes. */
export function withDescendants(id: string, projects: Project[]): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of projects) if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) { out.add(p.id); grew = true; }
  }
  return out;
}

/** Cadena de antepasados, de la raíz al propio proyecto. */
export function ancestry(id: string, map: Map<string, Project>): Project[] {
  const out: Project[] = [];
  const seen = new Set<string>();
  let cur = map.get(id);
  while (cur && !seen.has(cur.id)) {
    out.unshift(cur);
    seen.add(cur.id);
    cur = cur.parent_id ? map.get(cur.parent_id) : undefined;
  }
  return out;
}

/** "Caixa / Sprint 14 / Login". */
export const projectPath = (id: string, map: Map<string, Project>, sep = ' / ') =>
  ancestry(id, map).map((p) => p.name).join(sep);

/** Clave de ruta para la sintaxis "#caixa/sprint-14". */
export const pathKey = (id: string, map: Map<string, Project>) => ancestry(id, map).map((p) => nameKey(p.name)).join('/');

/** Archivado él o algún antepasado: no se muestra entre los activos. */
export const isEffectivelyArchived = (id: string, map: Map<string, Project>) => ancestry(id, map).some((p) => p.archived);

/** Profundidad del subárbol que cuelga de `id` (1 = sin hijos). */
function subtreeHeight(id: string, projects: Project[]): number {
  const kids = projects.filter((p) => p.parent_id === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => subtreeHeight(k.id, projects))) : 0);
}

/** ¿Se puede colocar `id` dentro de `parentId`? Sin ciclos y sin pasar de MAX_PROJECT_DEPTH. */
export function canMoveUnder(id: string, parentId: string | null, projects: Project[]): boolean {
  if (parentId === null) return true;
  if (withDescendants(id, projects).has(parentId)) return false;
  const map = new Map(projects.map((p) => [p.id, p]));
  return ancestry(parentId, map).length + subtreeHeight(id, projects) <= MAX_PROJECT_DEPTH;
}

/**
 * Resuelve "#nombre" o "#padre/hijo" de la captura. Con ruta, coincide el final de la ruta
 * ("sprint-14/login" encuentra "caixa/sprint-14/login"); sin ruta, el de menos profundidad.
 */
export function resolveProjectToken(value: string, projects: Project[]): Project | undefined {
  const map = new Map(projects.map((p) => [p.id, p]));
  const parts = value.split('/').map(nameKey).filter(Boolean);
  const want = parts.join('/');
  const candidates = projects
    .map((p) => ({ p, key: pathKey(p.id, map) }))
    .filter(({ key }) => key === want || key.endsWith(`/${want}`))
    .sort((a, b) => a.key.split('/').length - b.key.split('/').length);
  return candidates[0]?.p;
}
