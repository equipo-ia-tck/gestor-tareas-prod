import { DEFAULT_TYPE_ID, type ItemType, type NewTask, type StateCategory, type Task, type WorkflowState } from './types';
import { findType, stateOf } from './workflows';
import { fold } from './text';
import { columnLabel, type MsListItem } from './msListParse';
import type { RecordChange } from './rally';

/**
 * Microsoft List en el gestor: qué columna es el estado, a qué categoría del gestor corresponde cada valor y los
 * movimientos en los dos sentidos (la lista manda al leer; al mover aquí se apunta el cambio para la lista).
 */

export interface MsListConfig {
  /** Columna de la lista que hace de estado (p. ej. «Estado»). */
  statusColumn: string | null;
  /** Valor de la columna → categoría del gestor. Lo que no está se adivina por el nombre (`guessCategory`). */
  map: Record<string, StateCategory>;
}

export const LIST_CATEGORIES: { category: StateCategory; label: string }[] = [
  { category: 'todo', label: 'Por hacer' },
  { category: 'doing', label: 'En curso' },
  { category: 'blocked', label: 'Bloqueado' },
  { category: 'done', label: 'Hecho' },
];

const LIST_KEY = /^LS-(\d{1,12})$/;
/** ID externo de una tarea traída de la lista. */
export const listKey = (id: string) => `LS-${id}`;
export const listIdOf = (externalId: string | null | undefined) => LIST_KEY.exec(externalId ?? '')?.[1] ?? null;

/** Columnas de la lista en el orden en que aparecen. */
export function listColumns(items: MsListItem[]): string[] {
  const seen = new Set<string>();
  for (const it of items) for (const k of Object.keys(it.fields)) seen.add(k);
  return [...seen];
}

/**
 * Columna de estado más probable: una que se llame «Estado», «Status», «State», «Fase» o «Situación»; si no, la que
 * tiene entre 2 y 12 valores distintos y está en la mayoría de los elementos.
 */
export function guessStatusColumn(items: MsListItem[]): string | null {
  const columns = listColumns(items);
  const named = columns.find((c) => /^(estado|status|state|fase|situaci[oó]n|etapa)\b/i.test(columnLabel(c)));
  if (named) return named;
  let best: { column: string; count: number } | null = null;
  for (const column of columns) {
    const values = items.map((it) => it.fields[column]).filter(Boolean);
    const distinct = new Set(values).size;
    if (values.length >= items.length / 2 && distinct >= 2 && distinct <= 12 && (!best || values.length > best.count)) best = { column, count: values.length };
  }
  return best?.column ?? null;
}

/** Valores de una columna, sin repetir, en el orden en que aparecen. */
export function statusValues(items: MsListItem[], column: string | null): string[] {
  if (!column) return [];
  return [...new Set(items.map((it) => it.fields[column]).filter((v): v is string => !!v))];
}

/** Categoría que sugiere el nombre de un valor («En curso» → doing, «Cerrado» → done…). */
export function guessCategory(value: string): StateCategory {
  const v = value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/hech|complet|cerrad|termin|finaliz|resuel|done|closed|aprobad|entregad|ok\b/.test(v)) return 'done';
  if (/bloq|block|esper|hold|paus|parad|impedid|dependen/.test(v)) return 'blocked';
  if (/curso|progres|doing|desarroll|trabaj|revisi|review|validac|pruebas|activ/.test(v)) return 'doing';
  return 'todo';
}

export const categoryOfValue = (value: string | undefined, config: MsListConfig): StateCategory =>
  value ? config.map[value] ?? guessCategory(value) : 'todo';

/** Categoría de un elemento según la columna de estado. */
export const itemCategory = (item: MsListItem, config: MsListConfig): StateCategory =>
  categoryOfValue(config.statusColumn ? item.fields[config.statusColumn] : undefined, config);

/** Valor de la lista para una categoría del gestor: el primero que le corresponde (Accepted cuenta como Hecho). */
export function valueForCategory(category: StateCategory, values: string[], config: MsListConfig): string | null {
  const want = category === 'accepted' ? 'done' : category;
  return values.find((v) => categoryOfValue(v, config) === want) ?? null;
}

/** Tipo «Lista» del gestor: sus estados son los valores de la columna de estado de la lista. */
export const LIST_TYPE_ID = 'lista';

const CATEGORY_COLOR: Record<string, string> = { todo: '#2563eb', doing: '#16a34a', blocked: '#d97706', done: '#64748b', accepted: '#64748b' };
const stateIdFor = (value: string) => `lista-${fold(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'}`;

/**
 * El tipo «Lista» con un estado por cada valor de la columna de estado, en su orden y con su categoría (la de «Estados»).
 * Siempre tiene un estado de Por hacer y uno de Hecho (si la lista no los tiene, se añaden), para que completar y reabrir
 * funcionen como en los demás tipos.
 */
export function listItemType(values: string[], config: MsListConfig, order: number): ItemType {
  const seen = new Set<string>();
  const states: WorkflowState[] = [];
  for (const v of values) {
    const id = stateIdFor(v);
    if (seen.has(id)) continue;
    seen.add(id);
    const category = categoryOfValue(v, config);
    states.push({ id, name: v, color: CATEGORY_COLOR[category] ?? CATEGORY_COLOR.todo, category });
  }
  if (!states.some((st) => st.category === 'todo')) states.unshift({ id: 'lista-por-hacer', name: 'Por hacer', color: CATEGORY_COLOR.todo, category: 'todo' });
  if (!states.some((st) => st.category === 'done')) states.push({ id: 'lista-hecho', name: 'Hecho', color: CATEGORY_COLOR.done, category: 'done' });
  return { id: LIST_TYPE_ID, name: 'Lista', short: 'LS', color: '#0d9488', order, states };
}

/** ¿Hay que guardar el tipo? (no existe o sus estados no son los de la lista). */
export function listTypeChanged(current: ItemType | undefined, wanted: ItemType): boolean {
  if (!current) return true;
  const sig = (t: ItemType) => t.states.map((st) => `${st.id}:${st.name}:${st.category}`).join('|');
  return sig(current) !== sig(wanted);
}

/** El estado del tipo «Lista» que se llama como el valor de la lista (sin tildes ni mayúsculas). */
const stateNamed = (type: ItemType, value: string | undefined) => (value ? type.states.find((st) => fold(st.name) === fold(value)) : undefined);

export interface ListMove { task: Task; stateId: string; stateName: string; item: MsListItem }

/**
 * Tareas enlazadas cuya categoría no coincide con la de su elemento (la lista manda): pasan al primer estado de esa
 * categoría en su tipo. Una tarea en Accepted con el elemento en Hecho no se mueve (para la lista es lo mismo).
 */
export function listMoves(tasks: Task[], items: MsListItem[], config: MsListConfig, types: ItemType[]): ListMove[] {
  if (!config.statusColumn) return [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const moves: ListMove[] = [];
  for (const task of tasks) {
    if (task.deleted_at || task.status === 'archived') continue;
    const item = byId.get(listIdOf(task.external_id) ?? '');
    if (!item) continue;
    const current = stateOf(types, task);
    const type = findType(types, task.type_id);
    // Tipo «Lista»: el estado con el mismo nombre que el valor (Backlog ↔ Backlog), no solo de la misma categoría.
    const exact = task.type_id === LIST_TYPE_ID ? stateNamed(type, config.statusColumn ? item.fields[config.statusColumn] : undefined) : undefined;
    if (exact) {
      if (exact.id !== current.id) moves.push({ task, stateId: exact.id, stateName: exact.name, item });
      continue;
    }
    const want = itemCategory(item, config);
    if (current.category === want || (want === 'done' && current.category === 'accepted')) continue;
    const target = type.states.find((s) => s.category === want);
    if (target && target.id !== current.id) moves.push({ task, stateId: target.id, stateName: target.name, item });
  }
  return moves;
}

/**
 * Elementos de la lista que hay que cambiar porque su tarea ha cambiado de categoría en el gestor (o al deshacerlo).
 * Como en Rally, cuenta el estado antes del primer cambio de la entrada y después del último.
 */
export function listPushes(changes: RecordChange[], undo: boolean, types: ItemType[]): { id: string; category: StateCategory; stateName?: string }[] {
  const span = new Map<string, { first: Task | undefined; last: Task | undefined }>();
  for (const c of changes) {
    if (c.table !== 'tasks') continue;
    const key = ((c.after ?? c.before) as Task).id;
    const s = span.get(key);
    if (s) s.last = c.after as Task | undefined;
    else span.set(key, { first: c.before as Task | undefined, last: c.after as Task | undefined });
  }
  const out: { id: string; category: StateCategory; stateName?: string }[] = [];
  for (const { first, last } of span.values()) {
    const from = undo ? last : first;
    const to = undo ? first : last;
    const id = listIdOf(to?.external_id);
    if (!from || !to || !id || to.deleted_at || to.status === 'archived') continue;
    const category = stateOf(types, to).category;
    // Tipo «Lista»: cuenta cualquier cambio de estado (Backlog → Dependencia), y se manda con su nombre.
    if (to.type_id === LIST_TYPE_ID && stateOf(types, from).id !== stateOf(types, to).id) out.push({ id, category, stateName: stateOf(types, to).name });
    else if (stateOf(types, from).category !== category) out.push({ id, category });
  }
  return out;
}

/** Tarea nueva a partir de un elemento: título, enlace, ID externo y, en las notas, sus columnas. */
export function taskFromListItem(item: MsListItem, config: MsListConfig, projectId: string | null, listName = 'la lista', typeId = DEFAULT_TYPE_ID): NewTask {
  const lines = Object.entries(item.fields)
    .filter(([k]) => k !== config.statusColumn)
    .slice(0, 12)
    .map(([k, v]) => `${columnLabel(k)}: ${v.length > 300 ? `${v.slice(0, 299)}…` : v}`);
  return {
    title: item.title,
    external_id: listKey(item.id),
    url: item.url,
    type_id: typeId,
    project_id: projectId,
    notes: [`De ${listName} (elemento ${item.id})`, ...lines].join('\n'),
    raw_input: listKey(item.id),
  };
}

/**
 * Columnas del Tablero (las 7 de Rally) para los estados de la Lista, cuando se ven todos los tipos. Decisión de la
 * usuaria (nov 2026): backlog → New, in progress → In-Progress, dependencia → Need Review, completada → Accepted. Se
 * reconocen sin mayúsculas ni tildes y con variantes («in progres», «en curso», «completado»). Los demás estados van por
 * su grupo, como cualquier tarea.
 */
const LIST_COLUMN_RULES: { column: string; match: (name: string) => boolean }[] = [
  { column: 'New', match: (n) => n.startsWith('backlog') },
  { column: 'In-Progress', match: (n) => /^(in ?progres|en curso)/.test(n) },
  { column: 'Need Review', match: (n) => n.startsWith('dependencia') },
  { column: 'Accepted', match: (n) => n.startsWith('completad') },
];
const nameKey = (name: string) => fold(name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Columna del Tablero de un estado de la Lista (null si no es uno de los cuatro). */
export function listBoardColumn(stateName: string): string | null {
  const n = nameKey(stateName);
  return LIST_COLUMN_RULES.find((r) => r.match(n))?.column ?? null;
}

/** Columnas del Tablero en las que se pueden soltar elementos de la Lista (las otras tres no tienen estado en la lista). */
export const LIST_DROP_COLUMNS = LIST_COLUMN_RULES.map((r) => r.column);

/** Estado de la Lista al soltar una tarea en una columna del Tablero (undefined si la columna no admite elementos de la Lista o la lista no tiene ese estado). */
export function listStateForColumn(type: ItemType, column: string): WorkflowState | undefined {
  return LIST_DROP_COLUMNS.includes(column) ? type.states.find((st) => listBoardColumn(st.name) === column) : undefined;
}
