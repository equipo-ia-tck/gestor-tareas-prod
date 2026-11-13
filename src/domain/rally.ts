import { DEFAULT_TYPE_ID, type ItemType, type NewTask, type StateCategory, type Task } from './types';
import { findType, stateOf, typeForPrefix } from './workflows';

/**
 * Tipo de Rally: FE (feature; su ID empieza por FE o F), US (historia), DE (defecto), DS (defect suite), TA (tarea),
 * TS (test set), TC (test case).
 */
export type RallyKind = 'FE' | 'US' | 'DE' | 'DS' | 'TA' | 'TS' | 'TC';

/** Tipos que se pueden crear desde el gestor (los del formulario «New Item» de Rally, más las tareas). */
export type RallyCreatableKind = 'FE' | 'US' | 'DE' | 'DS' | 'TS' | 'TA';

/** Referencia de Rally relativa a la WSAPI ("/release/123") con su nombre. */
export interface RallyRef { ref: string; name: string }

/**
 * Opciones del formulario de alta de un tipo en un proyecto (`GET /api/rally/form`): personas, columnas, estados,
 * releases, iteraciones, etiquetas, milestones, valores permitidos y los campos personalizados obligatorios.
 */
export interface RallyFormOptions {
  me: RallyRef;
  users: RallyRef[];
  /** Columnas del tablero del proyecto, con el ScheduleState al que corresponde cada una. */
  flowStates: (RallyRef & { scheduleState: string | null })[];
  scheduleStates: string[];
  /** State de las tareas (Defined, In-Progress, Completed). */
  taskStates: string[];
  releases: RallyRef[];
  iterations: RallyRef[];
  milestones: RallyRef[];
  /** Feature: estados de portfolio (Discovering, Developing…) y tallas de Preliminary Estimate; vacíos en el resto. */
  portfolioStates: RallyRef[];
  preliminaryEstimates: RallyRef[];
  /** Valores permitidos de los campos de defecto (Severity, Priority, State, Environment); vacío si no aplica. */
  values: Record<string, string[]>;
  /** Campos personalizados obligatorios del tipo, para poder crearlo. */
  custom: { field: string; label: string; values: string[] }[];
}

/** Resultado del buscador «Elegir padre» (`GET /api/rally/pick`). */
export interface RallyPick { id: string; name: string; project: string | null; url?: string }

/** Lo que se envía al crear (`POST /api/rally/create`). Las referencias son las de `RallyFormOptions`. */
export interface RallyCreateInput {
  kind: RallyCreatableKind;
  name: string;
  projectId: string;
  /** US padre (US), User Story del defecto (DE) o US/defecto de la tarea (TA): su FormattedID. */
  parentId?: string;
  /** Feature de la US (F123). */
  featureId?: string;
  /** Feature: estado de portfolio, talla y fechas planificadas (YYYY-MM-DD). */
  portfolioStateRef?: string;
  preliminaryEstimateRef?: string;
  plannedStart?: string;
  plannedEnd?: string;
  description?: string;
  notes?: string;
  ownerRef?: string;
  assigneeRef?: string;
  color?: string;
  ready?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  expedite?: boolean;
  scheduleState?: string;
  flowStateRef?: string;
  /** State de una tarea o de un defecto. */
  state?: string;
  planEstimate?: number | null;
  estimate?: number | null;
  toDo?: number | null;
  releaseRef?: string;
  iterationRef?: string;
  tagRefs?: string[];
  milestoneRefs?: string[];
  severity?: string;
  priority?: string;
  environment?: string;
  custom?: Record<string, string>;
}

/** Colores de tarjeta de Rally (DisplayColor). */
export const RALLY_COLORS: { name: string; hex: string }[] = [
  { name: 'Azul', hex: '#105cab' }, { name: 'Celeste', hex: '#21a2e0' }, { name: 'Verde azulado', hex: '#107c83' },
  { name: 'Verde', hex: '#4a7c1e' }, { name: 'Lima', hex: '#8dc63f' }, { name: 'Amarillo', hex: '#fac71e' },
  { name: 'Naranja', hex: '#f76c02' }, { name: 'Rojo', hex: '#ee1c25' }, { name: 'Rosa', hex: '#df1a7b' },
  { name: 'Morado', hex: '#7832a5' }, { name: 'Gris', hex: '#848689' }, { name: 'Gris claro', hex: '#c0c0c0' },
];

/** Elemento de Rally (asignado a la persona o de los proyectos elegidos), tal como lo devuelve `GET /api/rally/items`. */
export interface RallyItem {
  /** FormattedID: "US1764574". */
  id: string;
  objectId: string;
  kind: RallyKind;
  name: string;
  /** Columna del tablero (FlowState) o, si no hay, ScheduleState, State o el último veredicto de un test case. */
  state: string;
  /** Orden de la columna en el tablero, para agrupar igual que Rally. */
  stateOrder: number;
  category: RallyCategory;
  done: boolean;
  blocked: boolean;
  /** Botón Ready de Rally (la tarjeta está lista para pasar a la siguiente columna). */
  ready: boolean;
  project: string | null;
  iteration: string | null;
  release: string | null;
  /** Assignee (o, si no hay, Owner). */
  assignee: string | null;
  /** Owner: en Rally, quien la ha puesto o la lleva ("Owned By" en las tarjetas). */
  owner: string | null;
  /** Asignado a la persona conectada. */
  mine: boolean;
  /** Etiquetas de Rally (los test sets se reparten por etiqueta, porque no tienen Assignee). */
  tags: string[];
  updatedAt: string;
  url: string;
  /** Solo al mover: comentario que toca dejar en la discusión (lo publica la app tras preguntar por el analista). */
  comment?: string;
}

export interface RallyProject { id: string; name: string }

/** Categoría para agrupar como el Tablero del gestor (Accepted aparte de Hecho, como en Rally). */
export type RallyCategory = 'todo' | 'blocked' | 'doing' | 'done' | 'accepted';

export const RALLY_CATEGORIES: { category: RallyCategory; label: string; color: string }[] = [
  { category: 'todo', label: 'Por hacer', color: '#94a3b8' },
  { category: 'blocked', label: 'Bloqueado', color: '#ef4444' },
  { category: 'doing', label: 'En curso', color: '#3b82f6' },
  { category: 'done', label: 'Hecho', color: '#22c55e' },
  { category: 'accepted', label: 'Accepted', color: '#047857' },
];

/** Ficha completa de un elemento, como en Rally (`GET /api/rally/detail`). Los textos llegan ya sin HTML. */
export interface RallyDetail {
  item: RallyItem;
  blockedReason: string | null;
  /** Campos con valor, con el nombre que les da Rally (incluidos los personalizados). */
  fields: { label: string; value: string }[];
  /** Descripción, notas, criterios de aceptación y demás textos largos. */
  texts: { label: string; text: string }[];
  tags: string[];
  /** Elementos hijos agrupados: "Tareas", "Test Cases", "Defectos", "User Stories hijas". */
  related: { label: string; items: RallyItem[] }[];
  discussion: { author: string | null; date: string; text: string }[];
  attachments: { name: string; size: number }[];
}

export type RallyGroupBy = 'category' | 'state' | 'iteration' | 'assignee' | 'tag';

export interface RallyStatus {
  connected: boolean;
  baseUrl: string;
  /** Últimos caracteres de la clave, para reconocerla sin mostrarla. */
  keyHint: string | null;
  rallyUser: string | null;
}

export const RALLY_KINDS: { kind: RallyKind; label: string }[] = [
  { kind: 'FE', label: 'Features' },
  { kind: 'US', label: 'User Stories' },
  { kind: 'DE', label: 'Defectos' },
  { kind: 'DS', label: 'Defect Suites' },
  { kind: 'TA', label: 'Tareas' },
  { kind: 'TS', label: 'Test Sets' },
  { kind: 'TC', label: 'Test Cases' },
];

const norm = (id: string | null) => (id ?? '').replace(/-/g, '').toUpperCase();

/** Tareas del gestor por ID de Rally (sin borrar; "US-123" y "US123" son la misma). */
export function tasksByRallyId(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) if (t.external_id) map.set(norm(t.external_id), t);
  return map;
}

/**
 * Owner en Rally de cada tarea enlazada (id de la tarea → nombre), a partir de lo último que se sabe de Rally.
 * Solo tareas del gestor con ID de Rally: así en Personas salen los Owners de lo que llevo, no todo el proyecto.
 */
export function rallyOwners(tasks: Task[], ownerOf: (rallyId: string) => string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tasks) {
    const owner = !t.deleted_at && isRallyId(t.external_id) ? ownerOf(norm(t.external_id!)) : null;
    if (owner) map.set(t.id, owner);
  }
  return map;
}

export const linkedTask = (item: RallyItem, byId: Map<string, Task>) => byId.get(norm(item.id));

const RALLY_ID = /^(US|DE|DS|TA|TS|TC|FE|F)-?\d{1,12}$/i;

/** ID externo con forma de Rally ("US1764574", "DE-9"…). */
export const isRallyId = (id: string | null | undefined): id is string => !!id && RALLY_ID.test(id);

/** IDs de Rally de las tareas activas (sin borrar ni archivar) que lo llevan, sin repetir. */
export function rallyIdsOf(tasks: Task[]): string[] {
  return [...new Set(tasks.filter((t) => !t.deleted_at && t.status !== 'archived' && t.external_id && RALLY_ID.test(t.external_id))
    .map((t) => norm(t.external_id)))];
}

export interface RallyMove { task: Task; stateId: string; stateName: string; item: RallyItem }

/**
 * Tareas enlazadas cuya categoría no coincide con la de Rally (Rally manda): pasan al primer estado de esa categoría
 * en su tipo. Si el tipo no tiene "Accepted", una aceptada en Rally va al de "hecho"; si no tiene la categoría, no se mueve.
 */
export function rallyMoves(tasks: Task[], items: RallyItem[], types: ItemType[]): RallyMove[] {
  const byId = new Map(items.map((it) => [norm(it.id), it]));
  const moves: RallyMove[] = [];
  for (const task of tasks) {
    if (task.deleted_at || task.status === 'archived' || !task.external_id) continue;
    const item = byId.get(norm(task.external_id));
    if (!item) continue;
    const current = stateOf(types, task);
    if (current.category === item.category) continue;
    const states = findType(types, task.type_id).states;
    const target = states.find((s) => s.category === item.category)
      ?? (item.category === 'accepted' ? states.find((s) => s.category === 'done') : undefined);
    if (target && target.id !== current.id) moves.push({ task, stateId: target.id, stateName: target.name, item });
  }
  return moves;
}

/** Cambio de un registro tal como lo guarda el historial del repositorio (antes y después). */
export interface RecordChange { table: string; before?: unknown; after?: unknown }

/**
 * Elementos de Rally que hay que mover porque su tarea ha cambiado de categoría en el gestor (en un cambio, o al
 * deshacerlo, que va de `after` a `before`). No cuentan las altas, las bajas ni los test cases (no tienen columna).
 */
function laterTodo(types: ItemType[], task: Task): boolean {
  const todo = findType(types, task.type_id).states.filter((st) => st.category === 'todo');
  return todo.findIndex((st) => st.id === task.state_id) > 0;
}

export interface RallyPush {
  /** FormattedID de Rally. */
  id: string;
  category: RallyCategory;
  /** Tarea del gestor y estado del que venía (para devolverla si se cancela el movimiento). */
  taskId: string;
  fromStateId: string;
}

export function rallyPushes(changes: RecordChange[], undo: boolean, types: ItemType[]): RallyPush[] {
  // Una entrada puede cambiar la misma tarea varias veces (completar y luego pasar a Accepted): cuenta el estado
  // antes del primer cambio y después del último (al deshacer, al revés).
  const span = new Map<string, { first: Task | undefined; last: Task | undefined }>();
  for (const c of changes) {
    if (c.table !== 'tasks') continue;
    const key = ((c.after ?? c.before) as Task).id;
    const s = span.get(key);
    if (s) s.last = c.after as Task | undefined;
    else span.set(key, { first: c.before as Task | undefined, last: c.after as Task | undefined });
  }
  const out: RallyPush[] = [];
  for (const { first, last } of span.values()) {
    const from = undo ? last : first;
    const to = undo ? first : last;
    if (!from || !to || to.deleted_at || to.status === 'archived' || !to.external_id || !RALLY_ID.test(to.external_id)) continue;
    const id = norm(to.external_id);
    const category = stateOf(types, to).category;
    // Los test cases (se mueven con su resultado) y las features (su State es de Rally) no se mueven desde aquí.
    if (/^(TC|F)/.test(id)) continue;
    const push = { id, category, taskId: to.id, fromStateId: stateOf(types, from).id };
    if (stateOf(types, from).category !== category) out.push(push);
    // Dentro de Por hacer, pasar a un estado posterior al primero (Refinada, Diseñado…) lleva de New a Defined en Rally.
    else if (category === 'todo' && from.state_id !== to.state_id && laterTodo(types, to)) out.push(push);
  }
  return out;
}

/** Tarea nueva a partir de un elemento de Rally: el tipo sale del prefijo (US, TS…) si existe uno con esa abreviatura. */
export function taskFromRally(item: RallyItem, types: ItemType[], projectId: string | null): NewTask {
  const type = typeForPrefix(types, item.kind);
  return {
    title: item.name,
    external_id: item.id,
    url: item.url,
    type_id: type?.id ?? DEFAULT_TYPE_ID,
    project_id: projectId,
    notes: [
      item.project && `Proyecto en Rally: ${item.project}`, item.iteration && `Iteración: ${item.iteration}`,
      !item.mine && item.assignee && `Assignee en Rally: ${item.assignee}`,
    ]
      .filter(Boolean).join('\n'),
    tags: item.tags,
    raw_input: item.id,
  };
}

const compare = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true });
/** Ordena con los vacíos al final. */
const nullsLast = (a: string | null, b: string | null, cmp: (a: string, b: string) => number) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : cmp(a, b);

/**
 * Agrupa por categoría (Por hacer, Bloqueado, En curso, Hecho, Accepted, aunque estén vacías), por columna del tablero
 * de Rally (en su orden), por iteración (la más reciente primero), por persona o por etiqueta (alfabético). Lo que no
 * tiene iteración, persona o etiqueta va al final. Por etiqueta, un elemento con varias sale en cada una.
 */
export function groupRally(items: RallyItem[], by: RallyGroupBy): { key: string | null; items: RallyItem[] }[] {
  if (by === 'category') {
    return RALLY_CATEGORIES.map(({ category, label }) => ({ key: label, items: items.filter((it) => it.category === category) }));
  }
  const keysOf = (it: RallyItem): (string | null)[] => (by === 'tag' ? (it.tags.length ? it.tags : [null])
    : [by === 'state' ? it.state : by === 'iteration' ? it.iteration : it.assignee]);
  const groups = new Map<string | null, RallyItem[]>();
  for (const it of items) for (const key of keysOf(it)) groups.set(key, [...(groups.get(key) ?? []), it]);
  const order = (list: RallyItem[]) => Math.min(...list.map((it) => it.stateOrder));
  return [...groups.entries()]
    .map(([key, list]) => ({ key, items: list }))
    .sort((a, b) => by === 'state' ? order(a.items) - order(b.items) || nullsLast(a.key, b.key, compare)
      : nullsLast(a.key, b.key, by === 'iteration' ? (x, y) => compare(y, x) : compare));
}

/**
 * Columnas del tablero de Rally, en su orden. Cada una dice a qué grupo del gestor corresponde y en cuál se ponen las
 * tareas que no están en Rally (o de las que aún no se sabe la columna): la marcada con `home`.
 */
export const RALLY_COLUMNS: { name: string; category: RallyCategory; color: string; home?: boolean }[] = [
  { name: 'New', category: 'todo', color: '#94a3b8', home: true },
  { name: 'Defined', category: 'todo', color: '#a78bfa' },
  { name: 'Blocked', category: 'blocked', color: '#ef4444', home: true },
  { name: 'In-Progress', category: 'doing', color: '#3b82f6', home: true },
  { name: 'Need Review', category: 'doing', color: '#f59e0b' },
  { name: 'Completed', category: 'done', color: '#22c55e', home: true },
  { name: 'Accepted', category: 'accepted', color: '#047857', home: true },
];

const columnKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Columna de Rally de una tarea: la que tiene en Rally si es una de la lista; si no, `chosen` (la columna en la que se
 * soltó, ya comprobada) o la de su grupo en el gestor.
 */
export function rallyColumnOf(rallyState: string | undefined, category: StateCategory, chosen?: string | null): string {
  const exact = rallyState && RALLY_COLUMNS.find((c) => columnKey(c.name) === columnKey(rallyState));
  if (exact) return exact.name;
  if (chosen && RALLY_COLUMNS.some((c) => c.name === chosen)) return chosen;
  return (RALLY_COLUMNS.find((c) => c.home && c.category === category) ?? RALLY_COLUMNS[0]).name;
}
