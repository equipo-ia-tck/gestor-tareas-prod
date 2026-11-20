import { DEFAULT_TYPE_ID, type ItemType, type NewTask, type StateCategory, type Task } from './types';
import { findType, stateOf } from './workflows';
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
  if (/bloq|block|esper|hold|paus|parad|impedid/.test(v)) return 'blocked';
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
    const want = itemCategory(item, config);
    const current = stateOf(types, task);
    if (current.category === want || (want === 'done' && current.category === 'accepted')) continue;
    const target = findType(types, task.type_id).states.find((s) => s.category === want);
    if (target && target.id !== current.id) moves.push({ task, stateId: target.id, stateName: target.name, item });
  }
  return moves;
}

/**
 * Elementos de la lista que hay que cambiar porque su tarea ha cambiado de categoría en el gestor (o al deshacerlo).
 * Como en Rally, cuenta el estado antes del primer cambio de la entrada y después del último.
 */
export function listPushes(changes: RecordChange[], undo: boolean, types: ItemType[]): { id: string; category: StateCategory }[] {
  const span = new Map<string, { first: Task | undefined; last: Task | undefined }>();
  for (const c of changes) {
    if (c.table !== 'tasks') continue;
    const key = ((c.after ?? c.before) as Task).id;
    const s = span.get(key);
    if (s) s.last = c.after as Task | undefined;
    else span.set(key, { first: c.before as Task | undefined, last: c.after as Task | undefined });
  }
  const out: { id: string; category: StateCategory }[] = [];
  for (const { first, last } of span.values()) {
    const from = undo ? last : first;
    const to = undo ? first : last;
    const id = listIdOf(to?.external_id);
    if (!from || !to || !id || to.deleted_at || to.status === 'archived') continue;
    const category = stateOf(types, to).category;
    if (stateOf(types, from).category !== category) out.push({ id, category });
  }
  return out;
}

/** Tarea nueva a partir de un elemento: título, enlace, ID externo y, en las notas, sus columnas. */
export function taskFromListItem(item: MsListItem, config: MsListConfig, projectId: string | null, listName = 'la lista'): NewTask {
  const lines = Object.entries(item.fields)
    .filter(([k]) => k !== config.statusColumn)
    .slice(0, 12)
    .map(([k, v]) => `${columnLabel(k)}: ${v.length > 300 ? `${v.slice(0, 299)}…` : v}`);
  return {
    title: item.title,
    external_id: listKey(item.id),
    url: item.url,
    type_id: DEFAULT_TYPE_ID,
    project_id: projectId,
    notes: [`De ${listName} (elemento ${item.id})`, ...lines].join('\n'),
    raw_input: listKey(item.id),
  };
}
