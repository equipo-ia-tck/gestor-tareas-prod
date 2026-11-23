import { fold } from './text';
import type { MsListField, MsListItem, MsListView } from './msListParse';

/**
 * Buscar mejor en la Lista, como en SharePoint: vistas, filtros por columna (casillas de valores o un rango de fechas),
 * agrupar y ordenar. Funciones puras sobre los elementos ya leídos.
 */

/** Hueco para «sin valor» en filtros y grupos («(Vacío)» en pantalla). */
export const EMPTY = '';

/** Filtro de una columna: valores marcados (o), y para fechas, desde/hasta (`YYYY-MM-DD`, incluidos). */
export interface ColumnFilter { values?: string[]; from?: string; to?: string }
export type ListFilters = Record<string, ColumnFilter>;

const MULTI = new Set(['MultiChoice', 'UserMulti', 'LookupMulti']);
const FACET_TYPES = new Set(['Choice', 'MultiChoice', 'Lookup', 'LookupMulti', 'User', 'UserMulti', 'Boolean']);
/** Texto o número con pocos valores distintos también se filtra por casillas. */
const MAX_FREE_VALUES = 25;

const valueOf = (item: MsListItem, column: string) => (column === 'Título' ? item.title : item.fields[column] ?? '');
/** Valores de un elemento en una columna (las de varios valores, separados). */
export function valuesOf(item: MsListItem, column: string, field?: MsListField): string[] {
  const v = valueOf(item, column);
  if (!v) return [EMPTY];
  return field && MULTI.has(field.type) ? v.split(/\s*,\s*/).filter(Boolean) : [v];
}

export const isDateField = (f?: MsListField) => f?.type === 'DateTime';

/** Columnas por las que se puede filtrar (con casillas o fechas) y agrupar, en el orden de la lista. */
export function filterableColumns(fields: MsListField[], items: MsListItem[]): MsListField[] {
  return fields.filter((f) => {
    if (f.label === 'Título') return false;
    if (FACET_TYPES.has(f.type) || isDateField(f)) return true;
    if (!['Text', 'Number', 'Currency'].includes(f.type)) return false;
    const distinct = new Set(items.map((it) => it.fields[f.label]).filter(Boolean));
    return distinct.size > 0 && distinct.size <= MAX_FREE_VALUES;
  });
}

/** Valores de una columna con cuántos elementos tiene cada uno: primero en el orden de las opciones, «(Vacío)» al final. */
export function facetValues(items: MsListItem[], field: MsListField): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of items) for (const v of valuesOf(it, field.label, field)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return orderValues([...counts.keys()], field).map((value) => ({ value, count: counts.get(value)! }));
}

function orderValues(values: string[], field?: MsListField): string[] {
  const choices = field?.choices ?? [];
  const rank = (v: string) => (v === EMPTY ? Number.MAX_SAFE_INTEGER : choices.includes(v) ? choices.indexOf(v) : choices.length);
  return [...values].sort((a, b) => rank(a) - rank(b) || compareValues(a, b, field));
}

function compareValues(a: string, b: string, field?: MsListField): number {
  if (field && (field.type === 'Number' || field.type === 'Currency')) {
    const x = Number(a.replace(',', '.'));
    const y = Number(b.replace(',', '.'));
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

/** ¿Pasa el elemento los filtros? Misma columna = cualquiera de los valores; columnas distintas = todas. */
export function matchesFilters(item: MsListItem, filters: ListFilters, fields: MsListField[]): boolean {
  for (const [column, f] of Object.entries(filters)) {
    const field = fields.find((x) => x.label === column);
    if (f.values?.length) {
      const own = valuesOf(item, column, field);
      if (!own.some((v) => f.values!.includes(v))) return false;
    }
    if (f.from || f.to) {
      const day = valueOf(item, column).slice(0, 10);
      if (!day || (f.from && day < f.from) || (f.to && day > f.to)) return false;
    }
  }
  return true;
}

/** Cuántas columnas tienen filtro. */
export const activeFilters = (filters: ListFilters) => Object.values(filters).filter((f) => f.values?.length || f.from || f.to).length;

/** Los elementos de una vista, en su orden (los que no están en la lista leída se ignoran). */
export function itemsInView(items: MsListItem[], view: MsListView | null): MsListItem[] {
  if (!view) return items;
  const byId = new Map(items.map((it) => [it.id, it]));
  return view.ids.map((id) => byId.get(id)).filter((it): it is MsListItem => !!it);
}

export type SortDir = 'asc' | 'desc';

/**
 * Ordena por una columna («ID» = por número de elemento). Sin valor, siempre al final. Con `keep` (sin orden elegido) se
 * deja el orden que traen (el de la vista, o por ID, que es como llega la lista).
 */
export function sortItems(items: MsListItem[], column: string, dir: SortDir, fields: MsListField[], keep = false): MsListItem[] {
  if (keep) return items;
  if (!column) return sortItems(items, 'ID', dir, fields);
  const field = fields.find((f) => f.label === column);
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (column === 'ID') return sign * (Number(a.id) - Number(b.id));
    const x = valueOf(a, column);
    const y = valueOf(b, column);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    const choices = field?.choices ?? [];
    if (choices.includes(x) && choices.includes(y)) return sign * (choices.indexOf(x) - choices.indexOf(y));
    return sign * compareValues(x, y, field) || Number(a.id) - Number(b.id);
  });
}

export interface ItemGroup { value: string; items: MsListItem[] }

/**
 * Agrupa por una columna (como «Agrupa per» de SharePoint): un grupo por valor, en el orden de las opciones y «(Vacío)»
 * al final. Las fechas se agrupan por día. Un elemento con varios valores sale en el grupo de su valor completo.
 */
export function groupItems(items: MsListItem[], column: string, fields: MsListField[]): ItemGroup[] {
  const field = fields.find((f) => f.label === column);
  const groups = new Map<string, MsListItem[]>();
  for (const it of items) {
    const raw = valueOf(it, column);
    const key = isDateField(field) ? raw.slice(0, 10) : raw;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return orderValues([...groups.keys()], field).map((value) => ({ value, items: groups.get(value)! }));
}

/** Búsqueda libre: ID, título y todas las columnas, sin tildes ni mayúsculas; todas las palabras. */
export function matchesText(item: MsListItem, query: string): boolean {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold(`${item.id} ${item.title} ${Object.values(item.fields).join(' ')}`);
  return words.every((w) => text.includes(w));
}
