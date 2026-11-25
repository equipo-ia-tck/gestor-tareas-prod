// Lo usa el conector MCP de Vercel (Node lo ejecuta sin empaquetar): los imports de valores llevan `.ts`.
import { addDays, mondayOf } from './dates.ts';
import { SearchIndex, type Chunk, type ChunkSource } from './knowledge.ts';
import { pageChunks, type ConfluencePage } from './confluence.ts';
import { mentionsOf } from './notes.ts';
import { ancestry, withDescendants } from './projects.ts';
import { fold, nameKey } from './text.ts';
import type { SharePointFolder } from './sharepoint';
import type { ActivityEntry, ISODate, ItemType, Note, Person, Project, StateCategory, Task } from './types';

/**
 * Conector de Marea para Claude (MCP), solo lectura. Funciones puras: reciben lo que ve la persona (ya filtrado por las
 * reglas de Supabase) y devuelven texto para Claude, con enlaces a Marea y a Rally para que pueda citar.
 */

export interface MareaData {
  /** Día de hoy en Madrid. */
  today: ISODate;
  /** Dirección de Marea, para los enlaces. */
  base: string;
  me: { id: string; name: string };
  tasks: (Task & { owner?: string | null })[];
  notes: (Note & { owner?: string | null })[];
  projects: Project[];
  people: Person[];
  types: ItemType[];
  activity: ActivityEntry[];
  /** Nombre de cada cuenta por su id (para «De X»). */
  accounts: Map<string, string>;
  /** Documentación del equipo subida desde Confluence (migración 014). */
  docs: ConfluencePage[];
  /** Carpetas de SharePoint guardadas por la persona en la pantalla SharePoint (solo nombre y enlace). */
  folders?: SharePointFolder[];
}

const TOPIC_TYPE_ID = 'topic';
const CATEGORY_NAMES: Record<StateCategory, string> = { todo: 'Por hacer', doing: 'En curso', blocked: 'Bloqueada', done: 'Hecha', accepted: 'Accepted' };
export const CATEGORY_KEYS = { por_hacer: 'todo', en_curso: 'doing', bloqueadas: 'blocked', hechas: 'done', accepted: 'accepted' } as const;
export const WHEN_KEYS = ['hoy', 'atrasadas', 'mi_dia', 'esta_semana', 'proxima_semana', 'proximos_7_dias', 'este_mes', 'sin_fecha', 'todas'] as const;
export type WhenKey = (typeof WHEN_KEYS)[number];

const live = <T extends { deleted_at?: string | null }>(x: T) => !x.deleted_at;
const isOpen = (t: Task) => t.status === 'todo' && !t.deleted_at;

function stateOf(d: MareaData, t: Task): { name: string; category: StateCategory; type: ItemType | undefined } {
  const type = d.types.find((x) => x.id === t.type_id);
  const st = type?.states.find((s) => s.id === t.state_id);
  const category: StateCategory = st?.category ?? (t.status === 'done' ? 'done' : 'todo');
  return { name: st?.name ?? CATEGORY_NAMES[category], category, type };
}

/** Enlace del elemento en Rally (u otra herramienta): el explícito o la plantilla del tipo. */
function externalLink(d: MareaData, t: Task): string | null {
  if (t.url) return t.url;
  const tpl = d.types.find((x) => x.id === t.type_id)?.url_template;
  return tpl && t.external_id ? tpl.replace('{id}', encodeURIComponent(t.external_id)) : null;
}

const link = (d: MareaData, hash: string) => `${d.base}/${hash}`;
const taskLink = (d: MareaData, t: Task) => link(d, `#/search/${encodeURIComponent(t.external_id || t.title)}`);
const noteLink = (d: MareaData, n: Note) => link(d, `#/notes/${encodeURIComponent(n.id)}`);
const projectLink = (d: MareaData, p: Project) => link(d, `#/project/${encodeURIComponent(p.id)}`);
const personLink = (d: MareaData, name: string) => link(d, `#/person/${encodeURIComponent(name)}`);

function projectName(d: MareaData, id: string | null): string | null {
  if (!id) return null;
  const map = new Map(d.projects.map((p) => [p.id, p]));
  const path = ancestry(id, map).map((p) => p.name);
  return path.length ? path.join(' / ') : null;
}

/** Una línea por tarea, con lo justo para que Claude la cite. */
export function taskLine(d: MareaData, t: Task & { owner?: string | null }): string {
  const st = stateOf(d, t);
  const bits = [
    st.type && st.type.short ? st.type.short : null,
    t.external_id,
    `«${t.title}»`,
    `estado: ${st.name}`,
    t.due_date ? `fecha: ${t.due_date}` : null,
    t.priority && t.priority < 4 ? `prioridad: ${t.priority}` : null,
    projectName(d, t.project_id) ? `proyecto: ${projectName(d, t.project_id)}` : null,
    t.people.length ? `personas: ${t.people.join(', ')}` : null,
    t.tags.length ? `etiquetas: ${t.tags.join(', ')}` : null,
    t.owner && t.owner !== d.me.id && d.accounts.get(t.owner) ? `de: ${d.accounts.get(t.owner)}` : null,
    `id: ${t.id}`,
  ].filter(Boolean);
  const ext = externalLink(d, t);
  return `- ${bits.join(' · ')}${ext ? ` · Rally: ${ext}` : ''}`;
}

/** Busca una persona por nombre completo, de pila o sin tildes entre todas las que conoce Marea. */
export function findPersonName(d: MareaData, raw: string): string | null {
  const q = nameKey(raw.replace(/^@/, ''));
  if (!q) return null;
  const names = knownPeople(d);
  const exact = names.find((n) => nameKey(n) === q);
  if (exact) return exact;
  const first = names.filter((n) => nameKey(n.split(/[\s\-_]+/)[0]) === q);
  if (first.length === 1) return first[0];
  const partial = names.filter((n) => nameKey(n).includes(q));
  return partial.length === 1 ? partial[0] : first[0] ?? partial[0] ?? null;
}

export function knownPeople(d: MareaData): string[] {
  const seen = new Map<string, string>();
  const add = (n: string) => { const k = nameKey(n); if (k && !seen.has(k)) seen.set(k, n); };
  d.people.forEach((p) => add(p.name));
  d.tasks.forEach((t) => t.people.forEach(add));
  d.notes.forEach((n) => n.people.forEach(add));
  d.accounts.forEach(add);
  return [...seen.values()];
}

const samePerson = (a: string, b: string) => nameKey(a) === nameKey(b);

export function findProject(d: MareaData, raw: string): Project | null {
  const q = nameKey(raw.replace(/^#/, ''));
  if (!q) return null;
  const map = new Map(d.projects.map((p) => [p.id, p]));
  const byPath = d.projects.find((p) => ancestry(p.id, map).map((x) => nameKey(x.name)).join('/') === q);
  if (byPath) return byPath;
  const exact = d.projects.filter((p) => nameKey(p.name) === q);
  if (exact.length) return exact.sort((a, b) => ancestry(a.id, map).length - ancestry(b.id, map).length)[0];
  const partial = d.projects.filter((p) => nameKey(p.name).includes(q));
  return partial.length ? partial.sort((a, b) => a.name.length - b.name.length)[0] : null;
}

function inWhen(t: Task, when: WhenKey, today: ISODate): boolean {
  const due = t.due_date;
  switch (when) {
    case 'hoy': return (!!due && due <= today) || t.my_day === today;
    case 'atrasadas': return !!due && due < today;
    case 'mi_dia': return t.my_day === today || t.type_id === TOPIC_TYPE_ID;
    case 'esta_semana': { const m = mondayOf(today); return !!due && due >= m && due <= addDays(m, 6); }
    case 'proxima_semana': { const m = addDays(mondayOf(today), 7); return !!due && due >= m && due <= addDays(m, 6); }
    case 'proximos_7_dias': return !!due && due >= today && due <= addDays(today, 7);
    case 'este_mes': return !!due && due.slice(0, 7) === today.slice(0, 7);
    case 'sin_fecha': return !due;
    default: return true;
  }
}

export interface TaskFilter {
  persona?: string;
  proyecto?: string;
  estado?: keyof typeof CATEGORY_KEYS;
  cuando?: WhenKey;
  solo_mias?: boolean;
  tipo?: string;
  texto?: string;
  limite?: number;
}

export function listTasks(d: MareaData, f: TaskFilter): string {
  const notes: string[] = [];
  const person = f.persona ? findPersonName(d, f.persona) : null;
  if (f.persona && !person) return `No conozco a ninguna persona llamada «${f.persona}» en Marea.`;
  const project = f.proyecto ? findProject(d, f.proyecto) : null;
  if (f.proyecto && !project) return `No hay ningún proyecto «${f.proyecto}» que puedas ver.`;
  const scope = project ? withDescendants(project.id, d.projects) : null;
  const category = f.estado ? CATEGORY_KEYS[f.estado] : null;
  const wantsDone = category === 'done' || category === 'accepted';
  const words = f.texto ? fold(f.texto).split(/\s+/).filter(Boolean) : [];
  const type = f.tipo ? d.types.find((x) => fold(x.short) === fold(f.tipo!) || fold(x.name) === fold(f.tipo!)) : null;
  if (f.tipo && !type) notes.push(`(No hay ningún tipo «${f.tipo}»; no se ha filtrado por tipo.)`);

  const found = d.tasks.filter((t) => {
    if (!live(t) || t.status === 'archived') return false;
    const st = stateOf(d, t);
    if (category) { if (st.category !== category) return false; } else if (!isOpen(t)) return false;
    if (wantsDone && t.status !== 'done') return false;
    if (person && !t.people.some((p) => samePerson(p, person))) return false;
    if (scope && !(t.project_id && scope.has(t.project_id))) return false;
    if (f.solo_mias && t.owner && t.owner !== d.me.id) return false;
    if (type && t.type_id !== type.id) return false;
    if (f.cuando && !inWhen(t, f.cuando, d.today)) return false;
    if (words.length) {
      const hay = fold(`${t.title} ${t.external_id ?? ''} ${t.notes} ${t.tags.join(' ')}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }).sort((a, b) => wantsDone
    ? (b.completed_at ?? '').localeCompare(a.completed_at ?? '')
    : (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.priority - b.priority);

  const limit = Math.min(Math.max(f.limite ?? 50, 1), 200);
  const head = [
    `${found.length} tarea${found.length === 1 ? '' : 's'}`,
    person ? `de ${person}` : null,
    project ? `en ${projectName(d, project.id)}` : null,
    f.cuando && f.cuando !== 'todas' ? `(${f.cuando.replace(/_/g, ' ')})` : null,
    category ? `en estado ${CATEGORY_NAMES[category]}` : found.length === 1 ? 'pendiente' : 'pendientes',
    `· hoy es ${d.today}`,
  ].filter(Boolean).join(' ');
  const more = found.length > limit ? `\n… y ${found.length - limit} más (sube «limite» o filtra más).` : '';
  return [head, ...notes, ...found.slice(0, limit).map((t) => taskLine(d, t))].join('\n') + more;
}

/** Trozos buscables de lo que ve la persona (y la documentación, cuando la haya). */
export function chunksOf(d: MareaData, extra: Chunk[] = []): Chunk[] {
  const out: Chunk[] = [];
  for (const t of d.tasks) {
    if (!live(t)) continue;
    out.push({ id: `task:${t.id}`, source: 'task', ref: t.id, title: t.title,
      text: [t.external_id, t.notes, t.people.map((p) => `@${p}`).join(' '), t.tags.join(' '), t.checklist.map((c) => c.text).join('\n')].filter(Boolean).join('\n') });
  }
  for (const n of d.notes) {
    if (!live(n)) continue;
    const body = n.body.replace(/\[\[t:[^\]]+\]\]/g, '');
    const paras = body.split(/\n(?=#{1,6}\s)/);
    paras.forEach((text, i) => out.push({ id: `note:${n.id}:${i}`, source: 'note', ref: n.id, title: n.title, text }));
  }
  for (const p of d.people) out.push({ id: `person:${p.name}`, source: 'person', ref: p.name, title: p.name, text: [p.role, p.notes].filter(Boolean).join('\n') });
  for (const p of d.projects) out.push({ id: `project:${p.id}`, source: 'project', ref: p.id, title: p.name, text: '' });
  for (const p of d.docs) out.push(...pageChunks(p));
  return [...out, ...extra];
}

const SOURCE_NAMES: Record<ChunkSource, string> = { task: 'Tarea', note: 'Nota', person: 'Persona', project: 'Proyecto', doc: 'Documentación', list: 'Lista' };

export function search(d: MareaData, query: string, opts: { sources?: ChunkSource[]; limit?: number; index?: SearchIndex } = {}): string {
  const index = opts.index ?? new SearchIndex(chunksOf(d));
  const hits = index.search(query, { limit: Math.min(opts.limit ?? 12, 40), sources: opts.sources });
  if (!hits.length) return `Nada en Marea para «${query}». Prueba con otras palabras o con listar_tareas.`;
  const tasks = new Map(d.tasks.map((t) => [t.id, t]));
  const notes = new Map(d.notes.map((n) => [n.id, n]));
  const projects = new Map(d.projects.map((p) => [p.id, p]));
  const docs = new Map(d.docs.map((p) => [p.id, p]));
  return [`${hits.length} resultado${hits.length === 1 ? '' : 's'} para «${query}»:`, ...hits.map((h) => {
    const c = h.chunk;
    let where = '';
    if (c.source === 'task' && tasks.get(c.ref)) where = taskLine(d, tasks.get(c.ref)!).slice(2);
    else if (c.source === 'note' && notes.get(c.ref)) {
      const n = notes.get(c.ref)!;
      where = `«${n.title}» (${n.kind === 'meeting' ? 'acta' : 'nota'} del ${n.date}${projectName(d, n.project_id) ? `, ${projectName(d, n.project_id)}` : ''}) · ${noteLink(d, n)} · id: ${n.id}`;
    } else if (c.source === 'project' && projects.get(c.ref)) where = `«${projectName(d, c.ref)}» · ${projectLink(d, projects.get(c.ref)!)}`;
    else if (c.source === 'person') where = `${c.ref} · ${personLink(d, c.ref)}`;
    else if (c.source === 'doc' && docs.get(c.ref)) {
      const p = docs.get(c.ref)!;
      where = `«${p.title}»${c.section ? ` › ${c.section}` : ''} · ${p.url}`;
    } else where = `«${c.title}»${c.section ? ` › ${c.section}` : ''}`;
    return `\n[${SOURCE_NAMES[c.source]}] ${where}\n> ${h.snippet}`;
  })].join('\n');
}

/** Busca solo en la documentación del equipo (Confluence). Cita el título, la ruta de la página y su enlace a Confluence. */
export function searchDocs(d: MareaData, query: string, opts: { limit?: number; index?: SearchIndex } = {}): string {
  if (!d.docs.length) return 'Aún no se ha subido documentación. Un administrador la sube en Ajustes → Documentación.';
  const index = opts.index ?? new SearchIndex(chunksOf(d));
  const hits = index.search(query, { limit: Math.min(opts.limit ?? 8, 20), sources: ['doc'] });
  if (!hits.length) return `Nada en la documentación para «${query}». Prueba con otras palabras.`;
  const docs = new Map(d.docs.map((p) => [p.id, p]));
  return [`${hits.length} resultado${hits.length === 1 ? '' : 's'} en la documentación para «${query}»:`, ...hits.map((h) => {
    const p = docs.get(h.chunk.ref);
    const head = p
      ? `«${p.title}»${h.chunk.section ? ` › ${h.chunk.section}` : ''}\n${p.path} · ${p.url}`
      : `«${h.chunk.title}»${h.chunk.section ? ` › ${h.chunk.section}` : ''}`;
    return `\n${head}\n> ${h.snippet}`;
  })].join('\n');
}

/** Una tarea por id, ID externo (US1234) o título. */
export function findTask(d: MareaData, raw: string): Task[] {
  const q = raw.trim();
  const byId = d.tasks.find((t) => t.id === q && live(t));
  if (byId) return [byId];
  const ext = fold(q).replace(/[-\s]/g, '');
  const byExt = d.tasks.filter((t) => live(t) && t.external_id && fold(t.external_id).replace(/[-\s]/g, '') === ext);
  if (byExt.length) return byExt;
  const f = fold(q);
  const exact = d.tasks.filter((t) => live(t) && fold(t.title) === f);
  if (exact.length) return exact;
  const words = f.split(/\s+/).filter((w) => w.length > 1);
  return d.tasks.filter((t) => live(t) && words.length && words.every((w) => fold(t.title).includes(w))).slice(0, 10);
}

export function taskDetail(d: MareaData, raw: string): string {
  const found = findTask(d, raw);
  if (!found.length) return `No encuentro ninguna tarea «${raw}». Usa buscar o listar_tareas.`;
  if (found.length > 1) return ['Hay varias; pide una por su id:', ...found.map((t) => taskLine(d, t))].join('\n');
  const t = found[0] as Task & { owner?: string | null };
  const st = stateOf(d, t);
  const linked = d.notes.filter((n) => live(n) && (n.task_id === t.id || n.body.includes(`[[t:${t.id}]]`)));
  const history = d.activity.filter((a) => a.task_id === t.id).sort((a, b) => a.at.localeCompare(b.at));
  const ext = externalLink(d, t);
  return [
    `# ${t.external_id ? `${t.external_id} · ` : ''}${t.title}`,
    `Tipo: ${st.type?.name ?? 'Tarea'} · Estado: ${st.name} (${CATEGORY_NAMES[st.category]})`,
    t.due_date ? `Fecha: ${t.due_date}` : 'Sin fecha',
    `Prioridad: ${t.priority}`,
    projectName(d, t.project_id) ? `Proyecto: ${projectName(d, t.project_id)}` : 'Sin proyecto',
    t.people.length ? `Personas: ${t.people.join(', ')}` : null,
    t.tags.length ? `Etiquetas: ${t.tags.join(', ')}` : null,
    t.owner && d.accounts.get(t.owner) ? `Creada por: ${d.accounts.get(t.owner)}` : null,
    `Creada: ${t.created_at.slice(0, 10)}${t.completed_at ? ` · Completada: ${t.completed_at.slice(0, 10)}` : ''}`,
    ext ? `Rally: ${ext}` : null,
    `Marea: ${taskLink(d, t)}`,
    t.notes.trim() ? `\n## Descripción\n${t.notes.trim()}` : null,
    t.checklist.length ? `\n## Pasos\n${t.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}` : null,
    linked.length ? `\n## Notas relacionadas\n${linked.map((n) => `- «${n.title}» (${n.date}) · id: ${n.id}`).join('\n')}` : null,
    history.length ? `\n## Historial\n${history.map((a) => `- ${a.date} ${a.kind}${a.from || a.to ? ` (${a.from ?? '—'} → ${a.to ?? '—'})` : ''}`).join('\n')}` : null,
  ].filter((x) => x !== null).join('\n');
}

export function noteDetail(d: MareaData, raw: string): string {
  const q = raw.trim();
  const f = fold(q);
  const found = d.notes.filter(live).filter((n) => n.id === q).concat(
    d.notes.filter(live).filter((n) => n.id !== q && fold(n.title) === f),
  );
  const list = found.length ? found : d.notes.filter((n) => live(n) && f.split(/\s+/).every((w) => fold(n.title).includes(w))).slice(0, 10);
  if (!list.length) return `No encuentro ninguna nota «${raw}». Usa buscar.`;
  if (list.length > 1) return ['Hay varias; pide una por su id:', ...list.map((n) => `- «${n.title}» (${n.date}) · id: ${n.id}`)].join('\n');
  const n = list[0];
  const tasks = new Map(d.tasks.map((t) => [t.id, t]));
  const body = n.body.replace(/\s*\[\[t:([\w-]+)\]\]/g, (_, id: string) => {
    const t = tasks.get(id);
    return t ? ` (→ tarea «${t.title}», ${stateOf(d, t).name})` : '';
  });
  return [
    `# ${n.title}`,
    `${n.kind === 'meeting' ? 'Acta de reunión' : 'Nota'} · ${n.date}${projectName(d, n.project_id) ? ` · ${projectName(d, n.project_id)}` : ''}`,
    n.people.length ? `Personas mencionadas: ${n.people.join(', ')}` : null,
    `Marea: ${noteLink(d, n)}`,
    '',
    body.length > 20000 ? `${body.slice(0, 20000)}\n… (cortada)` : body,
  ].filter((x) => x !== null).join('\n');
}

export function personDetail(d: MareaData, raw: string): string {
  const name = findPersonName(d, raw);
  if (!name) return `No conozco a «${raw}» en Marea.`;
  const card = d.people.find((p) => samePerson(p.name, name));
  const open = d.tasks.filter((t) => isOpen(t) && t.people.some((p) => samePerson(p, name)));
  const topics = open.filter((t) => t.type_id === TOPIC_TYPE_ID);
  const rest = open.filter((t) => t.type_id !== TOPIC_TYPE_ID);
  const said = mentionsOf(name, d.notes.filter(live)).slice(0, 30);
  const meetings = d.notes.filter((n) => live(n) && n.kind === 'meeting' && n.people.some((p) => samePerson(p, name)))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  return [
    `# ${name}`,
    card?.role ? `Rol: ${card.role}` : null,
    card?.email ? `Email: ${card.email}` : null,
    card?.notes ? `Notas de la ficha: ${card.notes}` : null,
    `Marea: ${personLink(d, name)}`,
    `\n## Temas pendientes para hablar (${topics.length})`, ...topics.map((t) => taskLine(d, t)),
    `\n## Tareas pendientes con ${name} (${rest.length})`, ...rest.slice(0, 40).map((t) => taskLine(d, t)),
    `\n## Lo que dijo o se habló (${said.length} más recientes)`,
    ...said.map((m) => `- ${m.note.date} · «${m.note.title}»${m.section ? ` › ${m.section}` : ''}: ${m.text}`),
    `\n## Últimas reuniones`, ...meetings.map((n) => `- ${n.date} «${n.title}» · id: ${n.id}`),
  ].filter((x) => x !== null).join('\n');
}

export function projectDetail(d: MareaData, raw: string): string {
  const p = findProject(d, raw);
  if (!p) return `No hay ningún proyecto «${raw}» que puedas ver. Usa listar_proyectos.`;
  const scope = withDescendants(p.id, d.projects);
  const tasks = d.tasks.filter((t) => live(t) && t.status !== 'archived' && t.project_id && scope.has(t.project_id));
  const counts = new Map<StateCategory, number>();
  for (const t of tasks) { const c = stateOf(d, t).category; counts.set(c, (counts.get(c) ?? 0) + 1); }
  const open = tasks.filter(isOpen).sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  const overdue = open.filter((t) => t.due_date && t.due_date < d.today).length;
  const doneWeek = tasks.filter((t) => t.status === 'done' && (t.completed_at ?? '') >= addDays(d.today, -7)).length;
  const children = d.projects.filter((x) => x.parent_id === p.id);
  const notes = d.notes.filter((n) => live(n) && n.project_id && scope.has(n.project_id)).sort((a, b) => b.date.localeCompare(a.date));
  return [
    `# ${projectName(d, p.id)}`,
    `Marea: ${projectLink(d, p)}`,
    `Cifras (con subproyectos): ${open.length} pendientes · ${counts.get('doing') ?? 0} en curso · ${counts.get('blocked') ?? 0} bloqueadas · ${overdue} atrasadas · ${doneWeek} hechas en 7 días · ${notes.length} notas`,
    children.length ? `Subproyectos: ${children.map((c) => c.name).join(', ')}` : null,
    `\n## Tareas pendientes (${open.length})`, ...open.slice(0, 60).map((t) => taskLine(d, t)),
    open.length > 60 ? `… y ${open.length - 60} más (usa listar_tareas con proyecto).` : null,
    ...folderSection(d, scope),
    `\n## Notas y actas recientes`, ...notes.slice(0, 15).map((n) => `- ${n.date} «${n.title}» · id: ${n.id}`),
  ].filter((x) => x !== null).join('\n');
}

/** Carpetas de SharePoint de un conjunto de proyectos (con el proyecto si es un subproyecto). */
function projectFolders(d: MareaData, scope: Set<string>): { folder: SharePointFolder; project: Project }[] {
  return d.projects.filter((p) => scope.has(p.id)).flatMap((p) => (p.folders ?? []).map((folder) => ({ folder, project: p })));
}

function folderSection(d: MareaData, scope: Set<string>): string[] {
  const list = projectFolders(d, scope);
  if (!list.length) return [];
  return [`\n## Carpetas de SharePoint (${list.length})`,
    ...list.map(({ folder, project }) => `- «${folder.name}» (${projectName(d, project.id)}): ${folder.url}`)];
}

/**
 * Carpetas de SharePoint guardadas en Marea: las de los proyectos (las ve quien ve el proyecto) y las personales. Solo
 * nombre y enlace: el contenido de las carpetas nunca sale de SharePoint.
 */
export function sharePointFolders(d: MareaData, project?: string, text?: string): string {
  let scope: Set<string> | null = null;
  if (project?.trim()) {
    const p = findProject(d, project);
    if (!p) return `No hay ningún proyecto «${project}» que puedas ver. Usa listar_proyectos.`;
    scope = withDescendants(p.id, d.projects);
  }
  const words = fold(text ?? '').split(/\s+/).filter(Boolean);
  const match = (...parts: (string | null)[]) => words.every((w) => fold(parts.filter(Boolean).join(' ')).includes(w));
  const ofProjects = projectFolders(d, scope ?? new Set(d.projects.map((p) => p.id)))
    .filter(({ folder, project: p }) => match(folder.name, projectName(d, p.id)))
    .sort((a, b) => (projectName(d, a.project.id) ?? '').localeCompare(projectName(d, b.project.id) ?? '', 'es'));
  const mine = scope ? [] : (d.folders ?? []).filter((f) => match(f.name));
  if (!ofProjects.length && !mine.length) {
    return `No hay carpetas de SharePoint guardadas${project ? ` en «${project}»` : ''}${words.length ? ` que coincidan con «${text}»` : ''}. `
      + 'Se añaden en Marea, en la pantalla SharePoint o en la fila «Carpetas» de cada proyecto.';
  }
  return [
    ofProjects.length ? `## Carpetas de proyectos (${ofProjects.length})` : null,
    ...ofProjects.map(({ folder, project: p }) => `- «${folder.name}» · proyecto ${projectName(d, p.id)}: ${folder.url}`),
    mine.length ? `\n## Mis carpetas (${mine.length})` : null,
    ...mine.map((f) => `- «${f.name}»: ${f.url}`),
    '\nSolo es el enlace: el contenido de las carpetas no está en Marea. Se abren en SharePoint con la cuenta de cada persona.',
  ].filter((x) => x !== null).join('\n');
}

export function listProjects(d: MareaData): string {
  const map = new Map(d.projects.map((p) => [p.id, p]));
  const rows = d.projects.map((p) => ({ p, path: ancestry(p.id, map).map((x) => x.name).join(' / ') }))
    .sort((a, b) => a.path.localeCompare(b.path, 'es'));
  if (!rows.length) return 'No ves ningún proyecto.';
  return [`${rows.length} proyectos:`, ...rows.map(({ p, path }) => {
    const n = d.tasks.filter((t) => isOpen(t) && t.project_id === p.id).length;
    return `- ${path} · ${n} pendientes · id: ${p.id}`;
  })].join('\n');
}

const KIND_NAMES: Record<string, string> = { created: 'Creadas', completed: 'Hechas', reopened: 'Reabiertas', postponed: 'Pospuestas', deleted: 'Eliminadas', archived: 'Archivadas', state: 'Cambios de estado' };

/** Registro de la propia persona (lo hecho, pospuesto…) entre dos días. */
export function activityLog(d: MareaData, from?: string, to?: string, kind?: string): string {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from! : mondayOf(d.today);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to! : d.today;
  const rows = d.activity.filter((a) => a.date >= start && a.date <= end && (!kind || a.kind === kind))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!rows.length) return `No hay nada en tu registro del ${start} al ${end}.`;
  const groups = new Map<string, ActivityEntry[]>();
  for (const a of rows) groups.set(a.kind, [...(groups.get(a.kind) ?? []), a]);
  return [`Tu registro del ${start} al ${end}:`, ...[...groups].map(([k, list]) =>
    `\n## ${KIND_NAMES[k] ?? k} (${list.length})\n${list.map((a) => `- ${a.date} «${a.title}»${projectName(d, a.project_id) ? ` · ${projectName(d, a.project_id)}` : ''}${a.from || a.to ? ` (${a.from ?? '—'} → ${a.to ?? '—'})` : ''}`).join('\n')}`)].join('\n');
}

/** Lo que Claude lee al conectarse: qué es Marea y cómo responder. */
export const MCP_INSTRUCTIONS = `Marea es el gestor de tareas del equipo de analítica (WPP/VML) que trabaja para CaixaBank.
Este conector da acceso de solo lectura a lo que la persona conectada puede ver en Marea: sus tareas y las compartidas con ella,
notas y actas de reunión, fichas de personas, proyectos y su registro de actividad.

También da acceso a la documentación del equipo (export de Confluence): cómo trabaja el equipo, modelos operativos, glosarios y
para qué sirve cada cosa. Se busca con «buscar_en_documentacion».

Las carpetas de SharePoint que el equipo guarda en Marea (por proyecto o personales) se consultan con «carpetas_sharepoint»: solo
nombre y enlace, nunca el contenido de los documentos. Para «¿dónde está la documentación / los entregables de X?», dalas con su enlace.

Glosario: US = User Story (en Rally, normalmente una guía de etiquetado); TS = Test Scenario / Test Set (la validación de una US);
DE = defecto; FE = feature; TA = tarea de Rally. Los IDs de Rally tienen la forma US1234567 o TS92615. «Para hablar» son temas
pendientes con una persona. «Mi día» es la lista que cada uno elige para hoy. Estados: Por hacer, En curso, Bloqueada, Hecha, Accepted.

Cómo responder:
- Responde en español y cita siempre de dónde sale cada dato (título de la tarea, nota o página y su enlace a Marea, Rally o Confluence).
- Preguntas abiertas sobre el trabajo diario del equipo («¿qué se habló de…?») → «buscar»; sobre cómo funciona algo, procesos o conceptos
  («¿cómo se valida una guía?», «¿qué es…?») → «buscar_en_documentacion»; para listas de tareas → «listar_tareas».
- Si algo no está en Marea ni en la documentación, dilo; no lo inventes. Este conector no puede crear ni cambiar nada en Marea.
- Si el mensaje trae un «id de Marea» (viene del botón «Preguntar a Claude» del Asistente), al terminar llama una vez a
  «responder_en_marea» con ese id y tu respuesta completa en Markdown, con los enlaces: así la persona la ve en Marea.`;
