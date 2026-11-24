/**
 * Microsoft List (SharePoint) tal como la manda el marcador «Marea · Lista» (`features/mslist/bookmarklet.ts`), que se
 * ejecuta en la página de la lista con la sesión de quien lo pulsa. Lo que llega por `postMessage` viene de otra web:
 * se valida aquí antes de guardarlo.
 */

/** Elemento de la lista con sus columnas ya convertidas a texto, por su nombre visible. */
export interface MsListItem {
  /** ID del elemento en SharePoint (numérico, como texto). */
  id: string;
  title: string;
  /** Nombre visible de la columna → valor legible (opción, persona, fecha…). Sin el título. */
  fields: Record<string, string>;
  /** Enlace a la ficha del elemento en SharePoint. */
  url: string | null;
  modified: string | null;
}

/** Columna de la lista. */
export interface MsListField {
  /** Nombre interno en SharePoint (el que se usa al escribir). */
  name: string;
  /** Nombre visible (la clave de `MsListItem.fields`). */
  label: string;
  /** Tipo de SharePoint: Text, Note, Choice, MultiChoice, Number, Currency, DateTime, Boolean, User, Lookup, URL… */
  type: string;
  choices: string[];
  /** Si se puede cambiar desde el gestor (texto, opciones, números, fechas y sí/no; personas y búsquedas, no). */
  editable: boolean;
  format?: 'date' | 'datetime';
  /** Obligatoria al crear (las listas leídas antes no lo traen). */
  required?: boolean;
  /** Valor por defecto de SharePoint al crear (p. ej. la primera opción de «Estado»). */
  defaultValue?: string | null;
}

/** Una vista de la lista en SharePoint (las pestañas de arriba: «Seguimiento Track», «Todos los elementos»…). */
export interface MsListView {
  id: string;
  title: string;
  isDefault: boolean;
  /** Columnas que enseña, por nombre visible y en su orden. */
  columns: string[];
  /** Columna por la que agrupa, si agrupa. */
  groupBy: string | null;
  /** Elementos que salen en la vista, en su orden (SharePoint aplica su filtro y su orden). */
  ids: string[];
}

/** La lista entera, como la ha leído el marcador la última vez. */
export interface MsListSnapshot {
  title: string;
  /** Dirección de la lista en SharePoint. */
  url: string;
  fields: MsListField[];
  items: MsListItem[];
  views: MsListView[];
  /** Cuándo la leyó el marcador. */
  at: string;
}

/** Cambio hecho en el gestor que el marcador aplicará en la lista la próxima vez que se pulse. */
export interface MsListChange {
  id: string;
  /** Nombre visible de la columna («Título» para el título). */
  field: string;
  /** Valor nuevo como texto (vacío = quitarlo). */
  value: string;
  at: string;
}

/** Resultado de aplicar un cambio, por `changeKey` (o `new:…` en las altas, con el ID que le ha dado SharePoint). */
export interface MsListResult { key: string; ok: boolean; error?: string; id?: string; skipped?: string[] }

/** Elemento nuevo que se creará en la lista la próxima vez que haya conexión. */
export interface MsListCreate {
  /** `new:<uuid>`: así se reconoce su resultado. */
  key: string;
  /** Nombre visible de la columna → valor («Título» para el título). */
  values: Record<string, string>;
  at: string;
  /** Crear también la tarea de Marea enlazada, en este proyecto (null = Bandeja). */
  task?: { projectId: string | null } | null;
}

/** Nombre del título en los cambios (el marcador busca la columna `Title`). */
export const TITLE_FIELD = 'Título';

export const changeKey = (c: Pick<MsListChange, 'id' | 'field'>) => `${c.id}|${c.field}`;

/** Nombre legible de una columna (los nombres internos codifican espacios y tildes: `Fecha_x0020_l_x00ed_mite`). */
export const columnLabel = (name: string) => name.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Solo páginas de SharePoint Online (`https://<empresa>.sharepoint.com` o `<empresa>-my.sharepoint.com`). */
export const isSharePointOrigin = (origin: string) => /^https:\/\/[a-z0-9-]+\.sharepoint\.com$/i.test(origin);

const MAX_ITEMS = 10_000;
const MAX_FIELDS = 200;
const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** Valida lo que manda el marcador. Devuelve null si no tiene forma de lista. */
export function parseSnapshot(data: unknown): MsListSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.items) || !Array.isArray(d.fields)) return null;
  const url = str(d.url, 2000);
  if (!/^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i.test(url)) return null;
  const fields: MsListField[] = [];
  for (const f of d.fields.slice(0, MAX_FIELDS)) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const name = str(o.name, 200);
    const label = str(o.label, 200);
    if (!name || !label) continue;
    fields.push({
      name, label, type: str(o.type, 40),
      choices: Array.isArray(o.choices) ? o.choices.slice(0, 200).map((c) => str(c, 200)).filter(Boolean) : [],
      editable: o.editable === true,
      ...(o.format === 'date' || o.format === 'datetime' ? { format: o.format } : {}),
      ...(o.required === true ? { required: true } : {}),
      ...(typeof o.defaultValue === 'string' && o.defaultValue ? { defaultValue: o.defaultValue.slice(0, 500) } : {}),
    });
  }
  const items: MsListItem[] = [];
  for (const it of d.items.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = str(o.id, 20);
    if (!/^\d+$/.test(id)) continue;
    const values: Record<string, string> = {};
    if (o.fields && typeof o.fields === 'object') {
      for (const [k, v] of Object.entries(o.fields as Record<string, unknown>).slice(0, MAX_FIELDS)) {
        const text = str(v).trim();
        if (text) values[str(k, 200)] = text;
      }
    }
    const link = str(o.url, 2000);
    items.push({
      id,
      title: str(o.title, 500).trim() || `Elemento ${id}`,
      fields: values,
      url: /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i.test(link) ? link : null,
      modified: typeof o.modified === 'string' ? o.modified.slice(0, 40) : null,
    });
  }
  const views: MsListView[] = [];
  for (const v of Array.isArray(d.views) ? d.views.slice(0, 30) : []) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const title = str(o.title, 200).trim();
    if (!title || !Array.isArray(o.ids)) continue;
    views.push({
      id: str(o.id, 100) || title,
      title,
      isDefault: o.isDefault === true,
      columns: Array.isArray(o.columns) ? o.columns.slice(0, 50).map((c) => str(c, 200)).filter(Boolean) : [],
      groupBy: typeof o.groupBy === 'string' && o.groupBy ? o.groupBy.slice(0, 200) : null,
      ids: o.ids.slice(0, MAX_ITEMS).map((x) => str(x, 20)).filter((x) => /^\d+$/.test(x)),
    });
  }
  return { title: str(d.title, 200).trim() || 'Lista', url, fields, items, views, at: str(d.at, 40) || new Date().toISOString() };
}

/** Valor actual de una columna en un elemento (el título va aparte). */
export const itemValue = (item: MsListItem, field: string) => (field === TITLE_FIELD ? item.title : item.fields[field] ?? '');

/** Los elementos con los cambios pendientes ya puestos (así se ve lo que habrá en la lista). */
export function withPending(items: MsListItem[], pending: MsListChange[]): MsListItem[] {
  if (!pending.length) return items;
  const byId = new Map<string, MsListChange[]>();
  for (const c of pending) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  return items.map((it) => {
    const changes = byId.get(it.id);
    if (!changes) return it;
    const fields = { ...it.fields };
    let title = it.title;
    for (const c of changes) {
      if (c.field === TITLE_FIELD) title = c.value || title;
      else if (c.value) fields[c.field] = c.value;
      else delete fields[c.field];
    }
    return { ...it, title, fields };
  });
}

/**
 * Pendientes que quedan después de una lectura: fuera los aplicados bien y los que la lista ya refleja. Los que han
 * fallado se quedan (se ven con su error y se reintentan la próxima vez).
 */
export function remainingPending(pending: MsListChange[], items: MsListItem[], results: MsListResult[]): MsListChange[] {
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.key));
  const byId = new Map(items.map((it) => [it.id, it]));
  return pending.filter((c) => {
    if (ok.has(changeKey(c))) return false;
    const item = byId.get(c.id);
    return !item || itemValue(item, c.field) !== c.value;
  });
}

/** Añade un cambio pendiente: del mismo elemento y columna, solo el último. Si deja el valor como está en la lista, se quita. */
export function addPending(pending: MsListChange[], change: MsListChange, items: MsListItem[]): MsListChange[] {
  const rest = pending.filter((c) => changeKey(c) !== changeKey(change));
  const item = items.find((it) => it.id === change.id);
  return item && itemValue(item, change.field) === change.value ? rest : [...rest, change];
}

/**
 * Dirección de una lista a partir de lo que se pegue (la de la vista, con `AllItems.aspx?…`, o la de un elemento):
 * `https://<x>.sharepoint.com/…/Lists/<nombre>`. Null si no es de una lista de SharePoint Online.
 */
export function normalizeListUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(u.hostname)) return null;
    const m = /^(.*?\/Lists\/[^/]+)/i.exec(decodeURIComponent(u.pathname));
    return m ? u.origin + m[1] : null;
  } catch {
    return null;
  }
}
