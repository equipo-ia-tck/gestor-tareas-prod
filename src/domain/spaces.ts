import type { Note, Project, Task } from './types';

/**
 * Espacios apagados a petición de la usuaria (nov 2026): todo el mundo entra sin invitación y no se ven en la barra lateral,
 * Ajustes ni la página del proyecto. Lo ya compartido en espacios se sigue viendo. Para volver a encenderlos, `true`.
 */
export const SPACES_ENABLED = false;

/** Espacio de equipo tal como lo devuelve el servidor. */
export interface Space {
  id: string;
  name: string;
  color: string;
  members: { id: string; role: 'admin' | 'member' }[];
  inviteCode: string;
  role: 'admin' | 'member';
}

/** "all" = todo; "personal" = lo que no está en ningún espacio; si no, el id de un espacio. */
export type SpaceFilter = 'all' | 'personal' | string;

/** Espacio de un proyecto: el suyo o el del primer antepasado que lo tenga (igual que en el servidor). */
export function spaceOfProject(projectId: string | null | undefined, projects: Map<string, Project>): string | null {
  let id = projectId ?? null;
  for (let depth = 0; id && depth < 10; depth++) {
    const p = projects.get(id);
    if (!p) return null;
    if (p.space_id) return p.space_id;
    id = p.parent_id;
  }
  return null;
}

export const spaceOf = (item: Pick<Task | Note, 'project_id'>, projects: Map<string, Project>) => spaceOfProject(item.project_id, projects);

export function matchesSpace(space: string | null, filter: SpaceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'personal') return space === null;
  return space === filter;
}
