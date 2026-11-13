import type { DatabaseSync } from 'node:sqlite';
import type { RallyCategory, RallyDetail, RallyFormOptions, RallyItem, RallyKind, RallyPick, RallyProject, RallyRef, RallyStatus } from '../src/domain/rally.ts';
import { ApiError } from './api.ts';
import type { TeamUser } from './auth.ts';
import { SqliteRallyAccounts, type RallyAccounts } from './rallyAccounts.ts';

/**
 * Conector de Rally (WSAPI v2) con la clave personal de cada usuario. La clave se guarda solo aquí (nunca vuelve
 * al navegador) y las consultas salen del servidor, así no hay problemas de CORS. Lee lo asignado a la persona o todo
 * lo de los proyectos que elija, y escribe cuatro cosas: elementos nuevos (US, defectos y tareas), la columna de un
 * elemento cuando se mueve en el gestor, los comentarios que se publican en su discusión y los archivos que se adjuntan.
 */

/** Rally de Europa (el que usamos); se puede cambiar al conectar. */
export const DEFAULT_RALLY_URL = 'https://eu1.rallydev.com';
const PAGE = 200;
/** Tamaño máximo de un adjunto (va en base64 dentro de un JSON de como mucho 50 MB). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Páginas de 200 por tipo en la pantalla Rally: hasta 5.000 de cada uno. */
const MAX_PAGES = 25;
const MAX_PROJECT_PAGES = 20;

type Fetch = typeof fetch;
type RallyObject = Record<string, unknown>;

/**
 * `_type` de Rally → prefijo y ruta de la página de detalle. `assignee`: el tipo tiene el campo personalizado
 * "Assignee", que es el que se usa para asignar (el Owner suele ser quien lo pidió).
 */
const KINDS: Record<string, { kind: RallyKind; path: string; typeName: string; assignee?: boolean; prefixes?: string[] }> = {
  // Features (portfolio items): su FormattedID empieza por FE o por F según el Rally.
  'portfolioitem/feature': { kind: 'FE', path: 'portfolioitem/feature', typeName: 'Feature', prefixes: ['FE', 'F'] },
  hierarchicalrequirement: { kind: 'US', path: 'userstory', typeName: 'HierarchicalRequirement', assignee: true },
  defect: { kind: 'DE', path: 'defect', typeName: 'Defect', assignee: true },
  defectsuite: { kind: 'DS', path: 'defectsuite', typeName: 'DefectSuite' },
  task: { kind: 'TA', path: 'task', typeName: 'Task', assignee: true },
  testset: { kind: 'TS', path: 'testset', typeName: 'TestSet' },
  testcase: { kind: 'TC', path: 'testcase', typeName: 'TestCase' },
};
/** Tipo de un FormattedID ("US1764574", "F123"…) o undefined. */
function kindOfId(id: string) {
  return Object.entries(KINDS).find(([, info]) => (info.prefixes ?? [info.kind]).some((p) => new RegExp(`^${p}\\d{1,12}$`).test(id)));
}

/** Columna del tablero a la que se mueve cada categoría (la primera que exista en el proyecto). */
const TARGET_FLOW: Record<RallyCategory, string[]> = {
  todo: ['defined', 'to do', 'new'],
  blocked: ['blocked'],
  doing: ['in-progress', 'in progress'],
  done: ['completed'],
  accepted: ['accepted'],
};
/** Si el proyecto no tiene columnas propias: ScheduleState (y State en las tareas, que no tienen Accepted). */
const TARGET_SCHEDULE: Record<RallyCategory, string | null> = { todo: 'Defined', blocked: null, doing: 'In-Progress', done: 'Completed', accepted: 'Accepted' };
const TARGET_TASK_STATE: Record<RallyCategory, string | null> = { todo: 'Defined', blocked: null, doing: 'In-Progress', done: 'Completed', accepted: 'Completed' };
const CATEGORIES = Object.keys(TARGET_FLOW) as RallyCategory[];
/** Tipos que se pueden crear desde el gestor. */
const CREATABLE = ['FE', 'US', 'DE', 'DS', 'TS', 'TA'];
/** Tipos del buscador «Elegir padre» → tipo de la WSAPI. */
const PICK_TYPES: Record<string, string> = { US: 'hierarchicalrequirement', DE: 'defect', F: 'portfolioitem/feature', PI: 'portfolioitem' };
const PICK_PAGE = 50;
/** Texto de búsqueda seguro dentro de una consulta de la WSAPI (sin comillas ni paréntesis). */
export const searchText = (q: unknown) => String(q ?? '').replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
/** Campos estándar del formulario cuyos valores permitidos se piden a Rally. */
const FORM_VALUES = ['ScheduleState', 'State', 'Severity', 'Priority', 'Environment'];

/** Colecciones que se muestran como elementos relacionados en la ficha. */
const RELATED: [string, string][] = [['Children', 'User Stories hijas'], ['Tasks', 'Tareas'], ['TestCases', 'Test Cases'], ['Defects', 'Defectos']];
/** Campos internos o que la ficha ya muestra en otro sitio. */
const HIDDEN = new Set(['ObjectID', 'ObjectUUID', 'VersionId', 'Subscription', 'Workspace', 'DisplayColor', 'DragAndDropRank', 'RevisionHistory',
  'ScheduleStatePrefix', 'Name', 'FormattedID', 'LatestDiscussionAgeInMinutes', 'Blocked', 'BlockedReason', 'Recycled', 'HasParent',
  'Expedite', 'Ready', 'Connections']);
const ASSIGNEE_FIELD = 'c_Assignee';
const DONE = new Set(['accepted', 'completed', 'released', 'closed', 'pass', 'done']);
/** Orden de las columnas cuando no hay FlowState (tablero sin columnas propias). */
const SCHEDULE = ['idea', 'new', 'submitted', 'defined', 'open', 'in-progress', 'fixed', 'completed', 'accepted', 'released', 'closed'];
const FETCH = 'FormattedID,Name,FlowState,OrderIndex,ScheduleState,State,LastVerdict,Blocked,Ready,Project,Iteration,Release,'
  + 'LastUpdateDate,ObjectID,Owner,c_Assignee,Tags';

/** Solo servidores de Rally (`https://*.rallydev.com`), sin ruta. */
export function normalizeBaseUrl(input: unknown): string {
  const raw = String(input ?? '').trim() || DEFAULT_RALLY_URL;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ApiError(400, 'La dirección de Rally no es válida.');
  }
  if (url.protocol !== 'https:' || !/(^|\.)rallydev\.com$/.test(url.hostname)) {
    throw new ApiError(400, 'La dirección debe ser de Rally (https://…rallydev.com).');
  }
  return url.origin;
}

const refName = (v: unknown) => (v && typeof v === 'object' ? String((v as RallyObject)._refObjectName ?? '') || null : null);
const refId = (v: unknown) => (v && typeof v === 'object' ? String((v as RallyObject)._ref ?? '').split('/').pop() ?? null : null);

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Texto legible a partir del HTML de Rally (párrafos, saltos y listas), sin etiquetas. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<img[^>]*>/gi, '[imagen]')
    .replace(/<\/(p|div|h\d|tr|ul|ol|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => e[0] === '#'
      ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === 'x' ? 2 : 1), e[1].toLowerCase() === 'x' ? 16 : 10))
      : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML de un comentario escrito en el gestor (texto plano: se escapa y los saltos de línea pasan a `<br>`). */
export function commentHtml(text: string): string {
  // Los enlaces van como <a> (si no, Rally los muestra como texto que no se puede pulsar).
  return text.trim().split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return escapeHtml(part);
    const [, url, tail] = /^(.*?)([.,;:!?)\]]*)$/.exec(part)!;
    const href = escapeHtml(/^www\./i.test(url) ? `https://${url}` : url);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(tail)}`;
  }).join('').replace(/\r?\n/g, '<br />');
}

/** Enlaces http(s) y www. dentro de un texto (con paréntesis de captura, para `split`). */
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"]+)/gi;
const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isHtml = (v: string) => /<\/?[a-z][^>]*>/i.test(v);

/** Valor legible de un campo de la WSAPI (null si está vacío, a cero o es una colección). */
export function fieldValue(v: unknown): string | null {
  if (v === null || v === undefined || v === '' || v === false || v === 0) return null;
  if (v === true) return 'Sí';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16).replace('T', ' ');
    return v;
  }
  if (typeof v === 'object') {
    const o = v as RallyObject;
    if (o.Count !== undefined) return null;
    return refName(o);
  }
  return null;
}

/**
 * Categoría del gestor a partir de la columna del tablero y el estado: Accepted (o Released/Closed), Hecho (Completed o
 * test pasado), Bloqueado (columna Blocked, marcado como bloqueado sin terminar o test fallido), En curso (In-Progress,
 * Need Review…) y Por hacer (el resto: New, Defined…). La marca Blocked solo cuenta si no hay columna (FlowState): con
 * tablero manda la columna, así marcar o desmarcar Blocked no cambia el elemento de bloque (ni en Rally ni en el gestor).
 */
export function rallyCategory(flow: string | null, schedule: string, blocked: boolean): RallyCategory {
  const f = (flow ?? '').toLowerCase();
  if (flow) blocked = false;
  const s = schedule.toLowerCase();
  if (['accepted', 'released', 'closed'].includes(s) || f === 'accepted') return 'accepted';
  if (s === 'completed' || s === 'pass' || s === 'done' || f === 'completed') return 'done';
  if (blocked || f.includes('block') || s === 'fail' || s === 'blocked') return 'blocked';
  if (s === 'in-progress' || s === 'fixed' || /progress|review|desarrollo|curso|test|qa/.test(f) || /develop|implement|measur/.test(s)) return 'doing';
  return 'todo';
}

/** Comentarios que se dejan en la discusión de Rally al mover un elemento desde el gestor. */
export const MOVE_COMMENTS = {
  defined: 'Guía definida correctamente',
  doing: 'Se comienza a trabajar en la guía solicitada',
  blocked: 'Guía bloqueada',
  done: 'Se finaliza la guía a la espera de validación',
  accepted: 'Tras la revisión y OK del PO, PO IT y analista, se entrega la guía y se da por Accepted la US.\n\nGracias!',
} as const;

const isNew = (state: string) => /^new$/i.test(state.trim());
const isDefined = (state: string) => /^defined$/i.test(state.trim());

/**
 * Comentario para un movimiento (null si no toca): de New a Defined, a En curso, a Bloqueado, a Completed o a Accepted.
 * Volver atrás a Por hacer no deja comentario.
 */
export function moveComment(from: Pick<RallyItem, 'state' | 'category'>, to: Pick<RallyItem, 'state' | 'category'>): string | null {
  if (from.category === to.category && from.state === to.state) return null;
  if (to.category === 'blocked') return from.category === 'blocked' ? null : MOVE_COMMENTS.blocked;
  if (to.category === 'doing') return from.category === 'doing' ? null : MOVE_COMMENTS.doing;
  if (to.category === 'done') return MOVE_COMMENTS.done;
  if (to.category === 'accepted') return from.category === 'accepted' ? null : MOVE_COMMENTS.accepted;
  if (to.category === 'todo' && isNew(from.state) && isDefined(to.state)) return MOVE_COMMENTS.defined;
  return null;
}

/** Persona de Rally que llega del navegador (`{ ref: '/user/123', name }`); null si no es válida. */
export function parseUserRef(v: unknown): RallyRef | null {
  if (!v || typeof v !== 'object') return null;
  const { ref, name } = v as { ref?: unknown; name?: unknown };
  const n = String(name ?? '').trim().slice(0, 120);
  return typeof ref === 'string' && /^\/user\/\d+$/.test(ref) && n ? { ref, name: n } : null;
}

/** Persona mencionada en un comentario, con su email de Rally (para invitarla a una reunión). */
export interface MentionedPerson { name: string; email: string | null }

/** Persona que se menciona: nombre visible y su ObjectUUID en Rally (sin UUID, Rally no la reconoce ni avisa). */
export interface Mention { name: string; uuid: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mención como la guarda el editor de Rally (`<span class="mention" data-mention="<ObjectUUID>">@Nombre</span>`): así Rally
 * avisa y manda el correo. Un enlace normal a la ficha se ve igual pero no notifica. Sin UUID queda como texto.
 */
export function mentionHtml(m: Mention): string {
  const name = `@${commentHtml(m.name)}`;
  return m.uuid && UUID.test(m.uuid) ? `<span class="mention" data-mention="${m.uuid.toLowerCase()}">${name}</span>` : name;
}

/** Comentario de un movimiento: «@PO texto» y, si lo hay, «Analista: @X» en otra línea. */
/**
 * Mensaje libre (plantilla del «Mensaje» al marcar Ready) con menciones: cada «@Nombre» de una persona elegida en Rally
 * pasa a la mención de Rally (la que avisa por correo). Primero los nombres más largos, para que «@Ana» no se coma
 * «@Ana María».
 */
export function messageHtml(text: string, mentions: Mention[]): string {
  let html = commentHtml(text);
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);
  // Marcadores para no volver a sustituir dentro de una mención ya puesta.
  sorted.forEach((m, i) => { html = html.split(`@${commentHtml(m.name)}`).join(`\u0000${i}\u0000`); });
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => mentionHtml(sorted[Number(i)]));
  return `<p>${html}</p>`;
}

/** Motivo de bloqueo a partir del comentario: sin saltos de línea y como mucho 256 caracteres. */
export function blockedReasonText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 256 ? `${t.slice(0, 255)}…` : t) : null;
}

export function moveCommentHtml(text: string, owner: Mention | null, analyst: Mention | null): string {
  const first = owner ? `${mentionHtml(owner)} ${commentHtml(text)}` : commentHtml(text);
  return `<p>${analyst ? `${first}<br />Analista: ${mentionHtml(analyst)}` : first}</p>`;
}

/** Une condiciones de la WSAPI, que solo admite dos por paréntesis: ((a OR b) OR c). */
export const joinQuery = (parts: string[], op: 'AND' | 'OR') => parts.reduce((acc, p) => `(${acc} ${op} ${p})`);

/**
 * Convierte un resultado de la WSAPI en un elemento del gestor (null si es de un tipo que no usamos). `meId`: ObjectID
 * de la persona conectada, para marcar lo suyo.
 */
export function toRallyItem(o: RallyObject, baseUrl: string, meId: string | null = null): RallyItem | null {
  const info = KINDS[String(o._type ?? '').toLowerCase()];
  if (!info) return null;
  // El State de una feature es un objeto (Discovering, Developing, Done…), con su orden.
  const stateRef = o.State && typeof o.State === 'object' ? o.State as RallyObject : null;
  const schedule = String(o.ScheduleState ?? (stateRef ? refName(stateRef) ?? '' : o.State) ?? o.LastVerdict ?? '')
    || (info.kind === 'TC' ? 'Sin ejecutar' : '');
  const flow = o.FlowState as RallyObject | null | undefined;
  const scheduleOrder = SCHEDULE.indexOf(schedule.toLowerCase());
  return {
    id: String(o.FormattedID ?? ''),
    objectId: String(o.ObjectID ?? ''),
    kind: info.kind,
    name: String(o.Name ?? '').trim() || String(o.FormattedID ?? ''),
    state: refName(flow) ?? schedule,
    stateOrder: typeof flow?.OrderIndex === 'number' ? flow.OrderIndex : typeof stateRef?.OrderIndex === 'number' ? stateRef.OrderIndex
      : scheduleOrder < 0 ? 99 : scheduleOrder,
    category: rallyCategory(refName(flow), schedule, o.Blocked === true),
    done: DONE.has(schedule.toLowerCase()),
    blocked: o.Blocked === true,
    ready: o.Ready === true,
    project: refName(o.Project),
    iteration: refName(o.Iteration),
    release: refName(o.Release),
    assignee: refName(o.c_Assignee) ?? refName(o.Owner),
    owner: refName(o.Owner),
    mine: meId !== null && (refId(o.c_Assignee) === meId || refId(o.Owner) === meId),
    tags: tagNames(o.Tags),
    updatedAt: String(o.LastUpdateDate ?? ''),
    url: `${baseUrl}/#/detail/${info.path}/${o.ObjectID}`,
  };
}

/** Nombres de las etiquetas que la WSAPI devuelve dentro de la colección Tags (`_tagsNameArray`). */
function tagNames(v: unknown): string[] {
  const list = v && typeof v === 'object' ? (v as RallyObject)._tagsNameArray : null;
  return Array.isArray(list) ? list.map((t) => String((t as RallyObject)?.Name ?? '').trim()).filter(Boolean) : [];
}

export class Rally {
  private accounts: RallyAccounts;
  private fetch: Fetch;

  /** `store`: la base de datos local (SQLite) o cualquier almacén de cuentas (en Vercel, Supabase cifrado). */
  constructor(store: DatabaseSync | RallyAccounts, fetcher: Fetch = fetch) {
    this.accounts = 'prepare' in store ? new SqliteRallyAccounts(store) : store;
    this.fetch = fetcher;
  }

  private account(user: TeamUser) {
    return this.accounts.get(user.id);
  }

  async status(user: TeamUser): Promise<RallyStatus> {
    const a = await this.account(user);
    return a ? { connected: true, baseUrl: a.base_url, keyHint: a.api_key.slice(-4), rallyUser: a.rally_user }
      : { connected: false, baseUrl: DEFAULT_RALLY_URL, keyHint: null, rallyUser: null };
  }

  private async get(baseUrl: string, apiKey: string, path: string): Promise<RallyObject> {
    let res: Response;
    try {
      res = await this.fetch(`${baseUrl}/slm/webservice/v2.0${path}`, { headers: { ZSESSIONID: apiKey, Accept: 'application/json' } });
    } catch {
      throw new ApiError(502, 'No se puede conectar con Rally. Revisa la conexión (o la VPN) y la dirección.');
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(400, 'Rally no acepta la clave: revísala o crea una nueva.');
    if (!res.ok) throw new ApiError(502, `Rally ha respondido con un error (${res.status}).`);
    const json = await res.json().catch(() => null) as RallyObject | null;
    if (!json) throw new ApiError(502, 'Rally no ha devuelto datos válidos.');
    const errors = (json.QueryResult as RallyObject | undefined)?.Errors as string[] | undefined;
    if (errors?.length) throw new ApiError(502, `Rally: ${errors.join(' ')}`);
    return json;
  }

  /** Escribe en Rally (crear o actualizar) y devuelve el objeto resultante. */
  private async post(a: { base_url: string; api_key: string }, path: string, body: unknown): Promise<RallyObject> {
    let res: Response;
    try {
      res = await this.fetch(`${a.base_url}/slm/webservice/v2.0${path}`, {
        method: 'POST',
        headers: { ZSESSIONID: a.api_key, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(502, 'No se puede conectar con Rally. Revisa la conexión (o la VPN).');
    }
    const json = await res.json().catch(() => null) as RallyObject | null;
    // Actualizar devuelve OperationResult y crear, CreateResult.
    const result = (json?.OperationResult ?? json?.CreateResult) as RallyObject | undefined;
    const errors = (result?.Errors ?? []) as string[];
    const denied = res.status === 401 || res.status === 403 || errors.some((e) => /not authorized|permission|read.?only|unauthorized/i.test(e));
    if (denied) throw new ApiError(400, 'Rally no deja modificar con esta clave: tiene que ser de acceso total (Full Access).');
    if (errors.length) throw new ApiError(502, `Rally: ${errors.join(' ')}`);
    if (!res.ok || !result?.Object) throw new ApiError(502, `Rally ha respondido con un error (${res.status}).`);
    return result.Object as RallyObject;
  }

  /** Comprueba la clave pidiendo el usuario de Rally y la guarda. */
  async connect(user: TeamUser, input: { apiKey?: unknown; baseUrl?: unknown }): Promise<RallyStatus> {
    const apiKey = String(input.apiKey ?? '').trim();
    if (!apiKey) throw new ApiError(400, 'Pega la clave de API de Rally.');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const me = (await this.get(baseUrl, apiKey, '/user')).User as RallyObject | undefined;
    if (!me?.ObjectID) throw new ApiError(400, 'Rally no ha devuelto tu usuario con esa clave.');
    const name = String(me.DisplayName || me._refObjectName || me.UserName || '');
    await this.accounts.set(user.id, { api_key: apiKey, base_url: baseUrl, rally_user_id: String(me.ObjectID), rally_user: name });
    return this.status(user);
  }

  async disconnect(user: TeamUser): Promise<RallyStatus> {
    await this.accounts.remove(user.id);
    return this.status(user);
  }

  private async connected(user: TeamUser) {
    const a = await this.account(user);
    if (!a) throw new ApiError(400, 'Conecta Rally con tu clave de API.');
    return a;
  }

  /** Proyectos abiertos a los que tiene acceso la clave: todos, de 200 en 200 (hasta 4.000). */
  async projects(user: TeamUser): Promise<RallyProject[]> {
    const a = await this.connected(user);
    const rows: RallyObject[] = [];
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const params = new URLSearchParams({ query: '(State = "Open")', fetch: 'Name,ObjectID', order: 'Name', pagesize: String(PAGE), start: String(page * PAGE + 1) });
      const result = (await this.get(a.base_url, a.api_key, `/project?${params}`)).QueryResult as RallyObject;
      const batch = (result?.Results ?? []) as RallyObject[];
      rows.push(...batch);
      if (batch.length < PAGE || rows.length >= Number(result?.TotalResultCount ?? 0)) break;
    }
    return rows.map((p) => ({ id: String(p.ObjectID), name: String(p.Name ?? '') }));
  }

  /**
   * Actualizado en los últimos `days` días (0 = todo), más reciente primero: sin `projects`, lo asignado a la persona
   * (Assignee u Owner); con `projects` (ObjectID), todo lo de esos proyectos. Con `tags` (nombres), lo que tiene alguna
   * de esas etiquetas: en los proyectos elegidos o, sin proyectos, en todo Rally (los test sets no tienen Assignee y se
   * reparten por etiqueta). Una consulta por tipo, porque no todos tienen el campo Assignee.
   */
  async items(user: TeamUser, days = 90, projects: string[] = [], tags: string[] = []): Promise<RallyItem[]> {
    return (await this.itemsReport(user, days, projects, tags)).items;
  }

  /** Como `items`, y además los tipos que no han cabido (más de 5.000), para avisar en la pantalla. */
  async itemsReport(user: TeamUser, days = 90, projects: string[] = [], tags: string[] = []):
    Promise<{ items: RallyItem[]; truncated: { kind: RallyKind; total: number; shown: number }[] }> {
    const a = await this.connected(user);
    const ids = projects.filter((p) => /^\d+$/.test(p));
    const owner = `(Owner.ObjectID = ${a.rally_user_id})`;
    const since = days > 0 ? new Date(Date.now() - Math.min(days, 3650) * 86_400_000).toISOString().slice(0, 10) : null;
    const recent = (who: string) => (since ? `(${who} AND (LastUpdateDate >= "${since}"))` : who);
    const names = [...new Set(tags.map(searchText).filter(Boolean))].slice(0, 30);
    const tagged = names.length ? joinQuery(names.map((n) => `(Tags.Name = "${n}")`), 'OR') : null;
    const projectsOnly = ids.length ? joinQuery(ids.map((id) => `(Project.ObjectID = ${id})`), 'OR') : null;
    const inProjects = projectsOnly && tagged ? `(${projectsOnly} AND ${tagged})` : projectsOnly ?? tagged;
    const items: RallyItem[] = [];
    const truncated: { kind: RallyKind; total: number; shown: number }[] = [];
    for (const [type, info] of Object.entries(KINDS)) {
      const query = recent(inProjects ?? (info.assignee ? `(${owner} OR (${ASSIGNEE_FIELD}.ObjectID = ${a.rally_user_id}))` : owner));
      // Un Rally sin el campo Assignee rechaza la consulta: entonces basta con el Owner. Uno sin features (portfolio
      // items) no las tiene: se siguen viendo los demás tipos.
      const { rows, total } = await this.queryAll(a, type, query).catch((e: unknown) => {
        if (info.assignee && e instanceof ApiError && e.message.includes(ASSIGNEE_FIELD)) return this.queryAll(a, type, recent(owner));
        if (info.kind === 'FE') return { rows: [], total: 0 };
        throw e;
      });
      if (total > rows.length) truncated.push({ kind: info.kind, total, shown: rows.length });
      for (const r of rows) {
        const item = toRallyItem({ _type: type, ...r }, a.base_url, a.rally_user_id);
        if (item) items.push(item);
      }
    }
    return { items: items.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)), truncated };
  }

  /**
   * Elementos por su ID ("US1764574", "DE9"…), para sincronizar las tareas del gestor enlazadas con Rally. Se agrupan
   * por tipo y se piden de 40 en 40 (la consulta va en la URL).
   */
  async lookup(user: TeamUser, input: { ids?: unknown }): Promise<RallyItem[]> {
    const a = await this.connected(user);
    const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).map((id) => String(id).replace(/-/g, '').toUpperCase()))]
      .filter((id) => !!kindOfId(id))
      .slice(0, 1000);
    const items: RallyItem[] = [];
    for (const type of Object.keys(KINDS)) {
      const mine = ids.filter((id) => kindOfId(id)?.[0] === type);
      for (let i = 0; i < mine.length; i += 40) {
        const query = joinQuery(mine.slice(i, i + 40).map((id) => `(FormattedID = "${id}")`), 'OR');
        for (const r of await this.query(a, type, query)) {
          const item = toRallyItem({ _type: type, ...r }, a.base_url, a.rally_user_id);
          if (item) items.push(item);
        }
      }
    }
    return items;
  }

  /** Columnas del tablero de un proyecto, en caché. */
  private flows = new Map<string, Promise<{ name: string; ref: string }[]>>();
  private flowStates(a: { base_url: string; api_key: string }, projectId: string) {
    const key = `${a.base_url} ${projectId}`;
    if (!this.flows.has(key)) {
      const params = new URLSearchParams({ query: `(Project.ObjectID = ${projectId})`, fetch: 'Name', order: 'OrderIndex', pagesize: '100' });
      const load = this.get(a.base_url, a.api_key, `/flowstate?${params}`).then((r) =>
        (((r.QueryResult as RallyObject)?.Results ?? []) as RallyObject[]).map((f) => ({ name: String(f.Name ?? ''), ref: String(f._ref ?? '') })));
      load.catch(() => this.flows.delete(key));
      this.flows.set(key, load);
    }
    return this.flows.get(key)!;
  }

  /**
   * Mueve un elemento a la columna de una categoría (cuando se mueve su tarea en el gestor). No escribe si ya está en
   * esa categoría. Al sacarlo de Bloqueado se le quita la marca de bloqueo; las tareas de Rally cambian su State.
   */
  /**
   * Mueve un elemento a la columna de la categoría. Con `dryRun` no escribe nada: devuelve cómo quedaría y el comentario
   * que tocaría, para que la app pregunte por el analista (y se pueda cancelar) antes de mover de verdad.
   */
  async move(user: TeamUser, input: { id?: unknown; category?: unknown; dryRun?: unknown; blockedReason?: unknown; flow?: unknown }): Promise<RallyItem> {
    const a = await this.connected(user);
    const id = String(input.id ?? '').replace(/-/g, '').toUpperCase();
    const category = input.category as RallyCategory;
    const entry = kindOfId(id);
    if (!entry || !CATEGORIES.includes(category)) throw new ApiError(400, 'Movimiento de Rally no válido.');
    const [type, info] = entry;
    if (info.kind === 'TC') throw new ApiError(400, 'Los test cases no tienen columna en Rally: se mueven con su resultado.');
    if (info.kind === 'FE') throw new ApiError(400, 'Las features cambian de estado en Rally.');
    const [o] = await this.query(a, type, `(FormattedID = "${id}")`);
    if (!o) throw new ApiError(404, `${id} no existe en Rally.`);
    const current = toRallyItem({ _type: type, ...o }, a.base_url, a.rally_user_id)!;
    // Columna concreta del tablero (Tablero «Como en Rally»: Need Review, Defined…); si el proyecto no la tiene, por categoría.
    const flowWanted = typeof input.flow === 'string' ? input.flow.trim().slice(0, 80) : '';
    const sameFlow = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const toOtherColumn = !!flowWanted && type !== 'task' && !sameFlow(current.state, flowWanted);
    // Por hacer dentro de Por hacer solo sirve para pasar de New a Defined.
    const define = !flowWanted && category === 'todo' && current.category === 'todo' && isNew(current.state);
    if (current.category === category && !define && !toOtherColumn) return current;

    const patch: RallyObject = {};
    let flowName: string | null = null;
    if (type === 'task') {
      if (TARGET_TASK_STATE[category]) patch.State = TARGET_TASK_STATE[category];
    } else {
      const projectId = refId(o.Project);
      const flows = projectId ? await this.flowStates(a, projectId) : [];
      const exact = flowWanted ? flows.find((f) => sameFlow(f.name, flowWanted)) : undefined;
      const targets = define ? ['defined'] : TARGET_FLOW[category];
      const flow = exact ?? targets.map((n) => flows.find((f) => f.name.toLowerCase() === n)).find(Boolean);
      if (flow) { patch.FlowState = flow.ref; flowName = flow.name; }
      else if (TARGET_SCHEDULE[category]) patch.ScheduleState = TARGET_SCHEDULE[category];
    }
    // Bloqueado marca siempre el botón Blocked (aunque haya columna Blocked) y escribe el motivo: el texto del comentario
    // sin menciones, en una línea y como mucho 256 caracteres (el límite de BlockedReason).
    if (category === 'blocked') {
      if (o.Blocked !== true) patch.Blocked = true;
      const reason = blockedReasonText(input.blockedReason);
      if (reason) patch.BlockedReason = reason;
    }
    if (category !== 'blocked' && o.Blocked === true) patch.Blocked = false;
    if (!Object.keys(patch).length) return current;
    if (input.dryRun === true) {
      const preview = toRallyItem({ _type: type, ...o, ...patch, ...(flowName ? { FlowState: { _refObjectName: flowName } } : {}) }, a.base_url, a.rally_user_id)!;
      const text = moveComment(current, preview);
      return { ...preview, ...(text ? { comment: text } : {}) };
    }
    const updated = await this.post(a, `/${type}/${o.ObjectID}?fetch=${FETCH}`, { [info.typeName]: patch });
    const item = toRallyItem({ _type: type, ...updated }, a.base_url, a.rally_user_id)!;
    // El comentario no se publica aquí: la app pregunta antes por el analista y lo manda con `moveCommentPost`.
    const text = moveComment(current, item);
    if (text) item.comment = text;
    return item;
  }

  /**
   * Publica en la discusión el comentario de un movimiento, mencionando al Owner (el PO) y, si se ha elegido, al
   * analista: «@PO Guía bloqueada» + «Analista: @X». El texto es el de `MOVE_COMMENTS` o el que se haya escrito con el lápiz.
   */
  async moveCommentPost(user: TeamUser, input: { id?: unknown; text?: unknown; analyst?: unknown; owner?: unknown }): Promise<{ text: string; owner: string | null; analyst: string | null; people: MentionedPerson[] }> {
    const a = await this.connected(user);
    const id = String(input.id ?? '').replace(/-/g, '').toUpperCase();
    // El texto parte de MOVE_COMMENTS, pero se puede modificar en la ventana antes de publicarlo.
    const text = String(input.text ?? '').trim();
    const entry = kindOfId(id);
    if (!entry || !text || text.length > 10_000) throw new ApiError(400, 'Comentario de Rally no válido.');
    const analyst = parseUserRef(input.analyst);
    if (input.analyst != null && !analyst) throw new ApiError(400, 'Analista no válido.');
    const ownerOverride = parseUserRef(input.owner);
    if (input.owner != null && !ownerOverride) throw new ApiError(400, 'Persona a mencionar no válida.');
    const [type] = entry;
    const [o] = await this.query(a, type, `(FormattedID = "${id}")`);
    if (!o) throw new ApiError(404, `${id} no existe en Rally.`);
    const { owner, people } = await this.postMoveComment(a, type, o, text, analyst, ownerOverride);
    return { text, owner, analyst: analyst?.name ?? null, people };
  }

  /**
   * Publica «@PO texto» + «Analista: @X» en la discusión de `o`. Devuelve el nombre del Owner mencionado y las personas
   * mencionadas con su email (para convocar la reunión de entrega desde la app).
   */
  private async postMoveComment(a: { base_url: string; api_key: string }, type: string, o: RallyObject, text: string, analyst: RallyRef | null,
    ownerOverride: RallyRef | null = null): Promise<{ owner: string | null; people: MentionedPerson[] }> {
    // Se menciona al Owner del elemento, salvo que en la ventana se haya elegido a otra persona en su lugar.
    let owner: Mention | null = null;
    let ownerInfo: { uuid: string | null; email: string | null } | null = null;
    if (ownerOverride) {
      ownerInfo = await this.userInfo(a, ownerOverride.ref.split('/').pop()!);
      owner = { name: ownerOverride.name, uuid: ownerInfo?.uuid ?? null };
    } else {
      const ownerRef = o.Owner && typeof o.Owner === 'object' ? o.Owner as RallyObject : null;
      const ownerId = refId(ownerRef);
      ownerInfo = ownerRef && ownerId && /^\d+$/.test(ownerId) ? await this.userInfo(a, ownerId) : null;
      owner = ownerRef && ownerInfo
        ? { name: refName(ownerRef) ?? 'Owner', uuid: typeof ownerRef._refObjectUUID === 'string' ? ownerRef._refObjectUUID : ownerInfo.uuid }
        : null;
    }
    const analystInfo = analyst ? await this.userInfo(a, analyst.ref.split('/').pop()!) : null;
    const analystMention: Mention | null = analyst ? { name: analyst.name, uuid: analystInfo?.uuid ?? null } : null;
    await this.post(a, '/conversationpost/create', { ConversationPost: { Artifact: `/${type}/${o.ObjectID}`, Text: moveCommentHtml(text, owner, analystMention) } });
    const people: MentionedPerson[] = [];
    if (owner) people.push({ name: owner.name, email: ownerInfo?.email ?? null });
    if (analystMention) people.push({ name: analystMention.name, email: analystInfo?.email ?? null });
    return { owner: owner?.name ?? null, people };
  }

  /**
   * TS a Need Review por errores de validación, todo a la vez: columna Need Review, Blocked con su motivo (que no va a la
   * discusión) y el comentario «@PO se abre defect <enlace>…» + «Analista: @X». Todo es obligatorio: defecto, analista,
   * comentario y motivo. Solo test sets.
   */
  async needReview(user: TeamUser, input: { id?: unknown; defectId?: unknown; text?: unknown; analyst?: unknown; reason?: unknown; owner?: unknown }):
    Promise<{ item: RallyItem; owner: string | null; analyst: string; commentError?: string }> {
    const a = await this.connected(user);
    const id = String(input.id ?? '').replace(/-/g, '').toUpperCase();
    const entry = kindOfId(id);
    if (!entry || entry[1].kind !== 'TS') throw new ApiError(400, 'Solo los TS pueden ir a Need Review.');
    const defectId = String(input.defectId ?? '').replace(/-/g, '').toUpperCase();
    if (!/^DE\d{1,12}$/.test(defectId)) throw new ApiError(400, 'Elige el defecto que se abre.');
    const text = String(input.text ?? '').trim();
    if (!text || text.length > 10_000) throw new ApiError(400, 'Escribe el comentario.');
    const analyst = parseUserRef(input.analyst);
    if (!analyst) throw new ApiError(400, 'Elige el analista.');
    const ownerOverride = parseUserRef(input.owner);
    if (input.owner != null && !ownerOverride) throw new ApiError(400, 'Persona a mencionar no válida.');
    const reason = blockedReasonText(input.reason);
    if (!reason) throw new ApiError(400, 'Escribe el motivo del bloqueo.');
    const [type, info] = entry;
    const [[o], [defect]] = await Promise.all([
      this.query(a, type, `(FormattedID = "${id}")`),
      this.query(a, 'defect', `(FormattedID = "${defectId}")`),
    ]);
    if (!o) throw new ApiError(404, `${id} no existe en Rally.`);
    if (!defect) throw new ApiError(404, `${defectId} no existe en Rally.`);
    const projectId = refId(o.Project);
    const flows = projectId ? await this.flowStates(a, projectId) : [];
    const flow = flows.find((f) => f.name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'needreview');
    if (!flow) throw new ApiError(400, `El proyecto de ${id} no tiene columna Need Review en Rally.`);
    const updated = await this.post(a, `/${type}/${o.ObjectID}?fetch=${FETCH}`, { [info.typeName]: { FlowState: flow.ref, Blocked: true, BlockedReason: reason } });
    const item = toRallyItem({ _type: type, ...updated }, a.base_url, a.rally_user_id)!;
    try {
      const { owner } = await this.postMoveComment(a, type, o, text, analyst, ownerOverride);
      return { item, owner, analyst: analyst.name };
    } catch (e) {
      return { item, owner: null, analyst: analyst.name, commentError: (e as Error).message };
    }
  }

  /**
   * Marca o desmarca Ready y Blocked (los botones de la ficha de Rally) sin cambiar la columna. Al bloquear, el motivo es
   * el texto del comentario (sin menciones, `blockedReasonText`); al desbloquear se borra.
   */
  async flag(user: TeamUser, input: { id?: unknown; ready?: unknown; blocked?: unknown; reason?: unknown }): Promise<RallyItem> {
    const a = await this.connected(user);
    const id = String(input.id ?? '').replace(/-/g, '').toUpperCase();
    const entry = kindOfId(id);
    if (!entry) throw new ApiError(400, 'Elemento de Rally no válido.');
    const [type, info] = entry;
    if (info.kind === 'TC' || info.kind === 'FE') throw new ApiError(400, 'Este tipo no tiene Ready ni Blocked en Rally.');
    const patch: RallyObject = {};
    if (typeof input.ready === 'boolean') patch.Ready = input.ready;
    if (typeof input.blocked === 'boolean') {
      patch.Blocked = input.blocked;
      if (input.blocked) {
        const reason = blockedReasonText(input.reason);
        if (reason) patch.BlockedReason = reason;
      } else patch.BlockedReason = '';
    }
    if (!Object.keys(patch).length) throw new ApiError(400, 'Nada que cambiar.');
    const [o] = await this.query(a, type, `(FormattedID = "${id}")`);
    if (!o) throw new ApiError(404, `${id} no existe en Rally.`);
    const updated = await this.post(a, `/${type}/${o.ObjectID}?fetch=${FETCH}`, { [info.typeName]: patch });
    return toRallyItem({ _type: type, ...updated }, a.base_url, a.rally_user_id)!;
  }

  /** Publica un mensaje en la discusión con las personas elegidas en Rally mencionadas (`messageHtml`). */
  async messagePost(user: TeamUser, input: { id?: unknown; text?: unknown; mentions?: unknown }): Promise<{ mentioned: string[] }> {
    const a = await this.connected(user);
    const id = String(input.id ?? '').replace(/-/g, '').toUpperCase();
    const text = String(input.text ?? '').trim();
    const entry = kindOfId(id);
    if (!entry || !text || text.length > 10_000) throw new ApiError(400, 'Mensaje de Rally no válido.');
    const raw = Array.isArray(input.mentions) ? input.mentions.slice(0, 20) : [];
    const refs = raw.map(parseUserRef);
    if (refs.some((r) => !r)) throw new ApiError(400, 'Persona no válida.');
    // Solo las que siguen en el texto (se pueden haber borrado al retocarlo).
    const used = (refs as RallyRef[]).filter((r, i, all) => text.includes(`@${r.name}`) && all.findIndex((x) => x.ref === r.ref) === i);
    const [type] = entry;
    const [o] = await this.query(a, type, `(FormattedID = "${id}")`);
    if (!o) throw new ApiError(404, `${id} no existe en Rally.`);
    const mentions = await Promise.all(used.map(async (r) => ({ name: r.name, uuid: (await this.userInfo(a, r.ref.split('/').pop()!))?.uuid ?? null })));
    await this.post(a, '/conversationpost/create', { ConversationPost: { Artifact: `/${type}/${o.ObjectID}`, Text: messageHtml(text, mentions) } });
    return { mentioned: used.map((r) => r.name) };
  }

  /**
   * ObjectUUID (lo necesita la mención para que Rally avise) y email de un usuario de Rally por su ObjectID.
   * Null si el id no es válido.
   */
  private async userInfo(a: { base_url: string; api_key: string }, objectId: string): Promise<{ uuid: string | null; email: string | null } | null> {
    if (!/^\d+$/.test(objectId)) return null;
    const [u] = await this.list(a, '/user', { query: `(ObjectID = ${objectId})`, fetch: 'ObjectUUID,EmailAddress', pagesize: '1' });
    // Rally lo devuelve en `_refObjectUUID` (el campo ObjectUUID no viene aunque se pida).
    const uuid = u?._refObjectUUID ?? u?.ObjectUUID;
    const email = u?.EmailAddress;
    return { uuid: typeof uuid === 'string' ? uuid : null, email: typeof email === 'string' && email.includes('@') ? email : null };
  }

  /** Caché de las opciones que cambian poco (etiquetas, milestones, valores permitidos): 10 minutos. */
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value as Promise<T>;
    const value = load();
    value.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async list(a: { base_url: string; api_key: string }, path: string, params: Record<string, string>): Promise<RallyObject[]> {
    const q = new URLSearchParams({ pagesize: String(PAGE), ...params });
    return (((await this.get(a.base_url, a.api_key, `${path}?${q}`)).QueryResult as RallyObject)?.Results ?? []) as RallyObject[];
  }

  private toRef(a: { base_url: string }, o: RallyObject, name = refName(o) ?? String(o.Name ?? '')): RallyRef | null {
    const ref = this.relative(a, o._ref);
    return ref && name ? { ref, name } : null;
  }

  /**
   * Atributos de un tipo con sus valores permitidos: los estándar del formulario y los personalizados obligatorios
   * (sin ellos Rally no deja crear).
   */
  private attributes(a: { base_url: string; api_key: string }, typeName: string) {
    return this.cached(`attrs ${a.base_url} ${typeName}`, async () => {
      const def = await this.list(a, '/typedefinition', { query: `(ElementName = ${typeName})`, fetch: 'Attributes' });
      const ref = this.relative(a, (def[0]?.Attributes as RallyObject | undefined)?._ref);
      const attrs = ref ? await this.collection(a, ref, 'ElementName,Name,Required,ReadOnly,Custom,AllowedValues') : [];
      const wanted = attrs.filter((x) => FORM_VALUES.includes(String(x.ElementName)) || (x.Custom === true && x.Required === true && x.ReadOnly !== true));
      return Promise.all(wanted.map(async (x) => {
        const allowed = x.AllowedValues as RallyObject | undefined;
        const vref = allowed && Number(allowed.Count) > 0 ? this.relative(a, allowed._ref) : null;
        const values = vref ? (await this.collection(a, vref, 'StringValue').catch(() => [])).map((v) => String(v.StringValue ?? '')).filter(Boolean) : [];
        return { field: String(x.ElementName), label: String(x.Name ?? x.ElementName), custom: x.Custom === true, values };
      }));
    });
  }

  /** Opciones del formulario «New Item» para un tipo en un proyecto. */
  async formOptions(user: TeamUser, kind: unknown, projectId: unknown): Promise<RallyFormOptions> {
    const a = await this.connected(user);
    const entry = Object.entries(KINDS).find(([, info]) => info.kind === kind);
    if (!entry || !CREATABLE.includes(String(kind))) throw new ApiError(400, 'Tipo de Rally no válido.');
    if (!/^\d+$/.test(String(projectId))) throw new ApiError(400, 'Elige el proyecto de Rally.');
    const [type, info] = entry;
    const pid = String(projectId);
    const inProject = { query: `(Project.ObjectID = ${pid})`, fetch: 'Name' };
    const refs = (rows: RallyObject[]) => rows.map((r) => this.toRef(a, r)).filter((r): r is RallyRef => !!r);
    const soft = <T,>(p: Promise<T>, empty: T) => p.catch(() => empty);
    const feature = info.kind === 'FE';
    const [flows, attrs, releases, iterations, members, permissions, milestones, portfolioStates, estimates] = await Promise.all([
      type === 'task' || feature ? Promise.resolve([]) : soft(this.list(a, '/flowstate', { ...inProject, fetch: 'Name,ScheduleStateMapping', order: 'OrderIndex' }), []),
      soft(this.attributes(a, info.typeName), []),
      soft(this.list(a, '/release', { ...inProject, order: 'ReleaseDate DESC', pagesize: '50' }), []),
      feature ? Promise.resolve([]) : soft(this.list(a, '/iteration', { ...inProject, order: 'StartDate DESC', pagesize: '50' }), []),
      soft(this.list(a, `/project/${pid}/TeamMembers`, { fetch: 'DisplayName,UserName' }), []),
      soft(this.list(a, '/projectpermission', { query: `(Project.ObjectID = ${pid})`, fetch: 'User' }), []),
      soft(this.cached(`milestones ${a.base_url}`, () => this.list(a, '/milestone', { fetch: 'Name', order: 'TargetDate DESC', pagesize: '100' })), []),
      // Features: estados de portfolio (Discovering, Developing…) y tallas de Preliminary Estimate, propios de cada Rally.
      feature ? this.featureStates(a) : Promise.resolve([]),
      feature ? soft(this.cached(`estimates ${a.base_url}`, () => this.list(a, '/preliminaryestimate', { fetch: 'Name,Value', order: 'Value' })), [])
        : Promise.resolve([]),
    ]);
    const me = { ref: `/user/${a.rally_user_id}`, name: a.rally_user };
    const users = new Map<string, RallyRef>([[me.ref, me]]);
    for (const u of [...members.map((m) => this.toRef(a, m, String(m.DisplayName || m._refObjectName || m.UserName || ''))),
      ...permissions.map((p) => (p.User ? this.toRef(a, p.User as RallyObject) : null))]) {
      if (u && !users.has(u.ref)) users.set(u.ref, u);
    }
    const valuesOf = (field: string) => attrs.find((x) => x.field === field)?.values ?? [];
    const values: Record<string, string[]> = {};
    if (type === 'defect') for (const f of ['Severity', 'Priority', 'State', 'Environment']) values[f] = valuesOf(f);
    return {
      me,
      users: [...users.values()].sort((x, y) => (x.ref === me.ref ? -1 : y.ref === me.ref ? 1 : x.name.localeCompare(y.name, 'es'))),
      flowStates: flows.map((f) => {
        const r = this.toRef(a, f);
        return r ? { ...r, scheduleState: String(f.ScheduleStateMapping ?? '') || null } : null;
      }).filter((f): f is RallyFormOptions['flowStates'][number] => !!f),
      scheduleStates: type === 'task' || feature ? [] : valuesOf('ScheduleState').length ? valuesOf('ScheduleState') : ['Defined', 'In-Progress', 'Completed', 'Accepted'],
      taskStates: type === 'task' ? (valuesOf('State').length ? valuesOf('State') : ['Defined', 'In-Progress', 'Completed']) : [],
      releases: refs(releases),
      iterations: refs(iterations),
      milestones: refs(milestones),
      portfolioStates: refs(portfolioStates.filter((st) => st.Enabled !== false)),
      preliminaryEstimates: refs(estimates),
      values,
      custom: attrs.filter((x) => x.custom).map(({ field, label, values: v }) => ({ field, label, values: v })),
    };
  }

  /** Personas de Rally por nombre, usuario o email (para Owner y Assignee), activas, como mucho 25. */
  async searchUsers(user: TeamUser, q: unknown): Promise<RallyRef[]> {
    const a = await this.connected(user);
    const text = searchText(q);
    if (text.length < 2) return [];
    const who = joinQuery([`(DisplayName contains "${text}")`, `(UserName contains "${text}")`, `(EmailAddress contains "${text}")`], 'OR');
    const rows = await this.list(a, '/user', { query: joinQuery([who, '(Disabled = false)'], 'AND'), fetch: 'DisplayName,UserName', order: 'DisplayName', pagesize: '25' });
    return rows.map((u) => this.toRef(a, u, String(u.DisplayName || u._refObjectName || u.UserName || ''))).filter((u): u is RallyRef => !!u);
  }

  /**
   * Buscador de «Elegir padre»: User Stories, defectos o features por palabra o ID, en un proyecto (o en todos), con
   * release y etiqueta opcionales; de 50 en 50 y los más nuevos primero, como en Rally.
   */
  async searchArtifacts(user: TeamUser, input: { types?: unknown; q?: unknown; project?: unknown; release?: unknown; tag?: unknown; page?: unknown }):
    Promise<{ items: RallyPick[]; total: number }> {
    const a = await this.connected(user);
    const types = [...new Set(String(input.types ?? '').split(',').map((t) => PICK_TYPES[t]).filter(Boolean))];
    if (!types.length) throw new ApiError(400, 'Tipo de elemento no válido.');
    const text = searchText(input.q);
    const conditions: string[] = [];
    if (text) {
      const id = text.replace(/[-\s]/g, '').toUpperCase();
      conditions.push(/^[A-Z]{1,2}\d{1,12}$/.test(id) ? `(FormattedID = "${id}")` : `(Name contains "${text}")`);
    }
    for (const [k, field] of [['project', 'Project'], ['release', 'Release'], ['tag', 'Tags']] as const) {
      const v = String(input[k] ?? '');
      if (/^\d+$/.test(v)) conditions.push(`(${field}.ObjectID = ${v})`);
    }
    const page = Math.max(1, Math.min(1000, Math.floor(Number(input.page) || 1)));
    const params = new URLSearchParams({
      types: types.join(','), fetch: 'FormattedID,Name,Project,ObjectID', order: 'CreationDate DESC', pagesize: String(PICK_PAGE), start: String((page - 1) * PICK_PAGE + 1),
      ...(conditions.length ? { query: joinQuery(conditions, 'AND') } : {}),
    });
    const result = (await this.get(a.base_url, a.api_key, `/artifact?${params}`)).QueryResult as RallyObject;
    const rows = (result?.Results ?? []) as RallyObject[];
    return {
      items: rows.map((r) => {
        const info = KINDS[String(r._type ?? '').toLowerCase()];
        return { id: String(r.FormattedID ?? ''), name: String(r.Name ?? ''), project: refName(r.Project),
          ...(info && r.ObjectID != null ? { url: `${a.base_url}/#/detail/${info.path}/${r.ObjectID}` } : {}) };
      }).filter((r) => r.id),
      total: Number(result?.TotalResultCount ?? rows.length),
    };
  }

  /** Etiquetas de Rally (hay miles): por nombre, de 50 en 50 y por orden alfabético. */
  async searchTags(user: TeamUser, input: { q?: unknown; page?: unknown }): Promise<{ items: RallyRef[]; total: number }> {
    const a = await this.connected(user);
    const text = searchText(input.q);
    const page = Math.max(1, Math.min(1000, Math.floor(Number(input.page) || 1)));
    const query = text ? joinQuery(['(Archived = false)', `(Name contains "${text}")`], 'AND') : '(Archived = false)';
    const params = new URLSearchParams({ query, fetch: 'Name', order: 'Name', pagesize: String(PICK_PAGE), start: String((page - 1) * PICK_PAGE + 1) });
    const result = (await this.get(a.base_url, a.api_key, `/tag?${params}`)).QueryResult as RallyObject;
    const rows = (result?.Results ?? []) as RallyObject[];
    return { items: rows.map((r) => this.toRef(a, r)).filter((r): r is RallyRef => !!r), total: Number(result?.TotalResultCount ?? rows.length) };
  }

  /**
   * Estados de portfolio de las features: las columnas de su Portfolio Kanban (Discovering, Refinement, Ready,
   * Developing…), en su orden. No todos los Rally aceptan la misma consulta, así que se prueban varias: por el ObjectID
   * de la definición del tipo, por su nombre y por su ElementName. Solo se guarda en caché si ha encontrado alguno.
   */
  private featureStates(a: { base_url: string; api_key: string }): Promise<RallyObject[]> {
    const key = `fe-states ${a.base_url}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value as Promise<RallyObject[]>;
    const fetchFields = 'Name,Enabled,OrderIndex';
    const byQuery = (query: string) => this.list(a, '/state', { query, fetch: fetchFields, order: 'OrderIndex' });
    const tries: (() => Promise<RallyObject[]>)[] = [
      async () => {
        const [def] = await this.list(a, '/typedefinition', { query: '(TypePath = "PortfolioItem/Feature")', fetch: 'ObjectID', pagesize: '1' });
        return def?.ObjectID ? byQuery(`(TypeDef.ObjectID = ${String(def.ObjectID)})`) : [];
      },
      () => byQuery('(TypeDef.Name = "Feature")'),
      () => byQuery('(TypeDef.ElementName = "Feature")'),
    ];
    const value = (async () => {
      for (const attempt of tries) {
        const rows = (await attempt().catch(() => [] as RallyObject[])).filter((r) => r.Enabled !== false);
        if (rows.length) return rows.sort((x, y) => Number(x.OrderIndex ?? 0) - Number(y.OrderIndex ?? 0));
      }
      console.log('[Rally] No se han podido leer los estados de Feature con ninguna consulta.');
      return [];
    })();
    this.cache.set(key, { at: Date.now(), value });
    void value.then((rows) => { if (!rows.length) this.cache.delete(key); }, () => this.cache.delete(key));
    return value;
  }

  /** ObjectID de un elemento por su FormattedID, comprobando que es de uno de los tipos dados. */
  private async findByFormattedId(a: { base_url: string; api_key: string }, id: string, types: Record<string, string>, what: string) {
    const clean = String(id).replace(/-/g, '').toUpperCase();
    const type = Object.entries(types).find(([prefix]) => clean.startsWith(prefix) && /^[A-Z]+\d{1,12}$/.test(clean))?.[1];
    if (!type) throw new ApiError(400, `${what}: indica su ID (${Object.keys(types).map((p) => `${p}…`).join(' o ')}).`);
    const [o] = await this.list(a, `/${type}`, { query: `(FormattedID = "${clean}")`, fetch: 'ObjectID,Project', pagesize: '1' });
    if (!o) throw new ApiError(404, `${clean} no existe en Rally.`);
    return { ref: `/${type}/${o.ObjectID}`, projectId: refId(o.Project) };
  }

  /**
   * Crea un elemento con los campos del formulario «New Item» de Rally: User Story, defecto, defect suite o test set en
   * un proyecto, o una tarea dentro de una US o un defecto (`parentId`). El Owner es quien la crea salvo que se elija
   * otro; el Assignee se pone con `assigneeRef` (o `assignToMe`) y, si el tipo no tiene ese campo, se crea sin él.
   */
  async create(user: TeamUser, input: Record<string, unknown>): Promise<RallyItem> {
    const a = await this.connected(user);
    const entry = Object.entries(KINDS).find(([, info]) => info.kind === input.kind);
    if (!entry || !CREATABLE.includes(String(input.kind))) throw new ApiError(400, 'Desde aquí se pueden crear User Stories, defectos, defect suites, test sets y tareas.');
    const [type, info] = entry;
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new ApiError(400, 'Escribe el nombre.');
    if (name.length > 256) throw new ApiError(400, 'El nombre es demasiado largo (máximo 256 caracteres).');
    const text = (k: string, max = 30_000) => {
      const v = String(input[k] ?? '').trim();
      if (v.length > max) throw new ApiError(400, `El campo ${k} es demasiado largo.`);
      return v;
    };
    const ref = (k: string, kinds: string) => {
      const v = String(input[k] ?? '');
      if (!v) return null;
      if (!new RegExp(`^/(${kinds})/\\d+$`).test(v)) throw new ApiError(400, `Valor no válido en ${k}.`);
      return v;
    };
    const num = (k: string) => {
      const v = input[k];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 9999) throw new ApiError(400, `El número de ${k} no es válido.`);
      return n;
    };
    const refs = (k: string, kinds: string) => (Array.isArray(input[k]) ? input[k] as unknown[] : []).slice(0, 50).map((v) => {
      if (!new RegExp(`^/(${kinds})/\\d+$`).test(String(v))) throw new ApiError(400, `Valor no válido en ${k}.`);
      return { _ref: String(v) };
    });

    const fields: RallyObject = { Name: name, Owner: ref('ownerRef', 'user') ?? `/user/${a.rally_user_id}` };
    const description = text('description');
    if (description) fields.Description = commentHtml(description);
    const notes = text('notes');
    if (notes) fields.Notes = commentHtml(notes);
    if (input.ready === true) fields.Ready = true;
    if (input.blocked === true) {
      fields.Blocked = true;
      const reason = text('blockedReason', 256);
      if (reason) fields.BlockedReason = reason;
    }
    const color = String(input.color ?? '');
    if (color) {
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ApiError(400, 'Color no válido.');
      fields.DisplayColor = color.toLowerCase();
    }
    const tags = refs('tagRefs', 'tag');
    if (tags.length) fields.Tags = tags;
    const milestones = refs('milestoneRefs', 'milestone');
    if (milestones.length) fields.Milestones = milestones;
    const release = ref('releaseRef', 'release');
    if (release) fields.Release = release;
    const iteration = ref('iterationRef', 'iteration');
    if (iteration) fields.Iteration = iteration;

    let projectId = String(input.projectId ?? '');
    const parentId = String(input.parentId ?? '').trim();
    if (type === 'task') {
      if (!parentId) throw new ApiError(400, 'Una tarea de Rally va dentro de una User Story o un defecto: indica su ID (US… o DE…).');
      const parent = await this.findByFormattedId(a, parentId, { US: 'hierarchicalrequirement', DE: 'defect' }, 'Una tarea de Rally va dentro de una User Story o un defecto');
      fields.WorkProduct = parent.ref;
      if (!/^\d+$/.test(projectId) && parent.projectId) projectId = parent.projectId;
      const state = text('state', 40);
      if (state) fields.State = state;
      const estimate = num('estimate');
      if (estimate !== null) fields.Estimate = estimate;
      const toDo = num('toDo');
      if (toDo !== null) fields.ToDo = toDo;
    } else if (info.kind === 'FE') {
      const state = ref('portfolioStateRef', 'state');
      if (state) fields.State = state;
      const estimate = ref('preliminaryEstimateRef', 'preliminaryestimate');
      if (estimate) fields.PreliminaryEstimate = estimate;
      for (const [k, field] of [['plannedStart', 'PlannedStartDate'], ['plannedEnd', 'PlannedEndDate']] as const) {
        const v = String(input[k] ?? '');
        if (!v) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, `Fecha no válida en ${k}.`);
        fields[field] = `${v}T12:00:00.000Z`; // a mediodía UTC: el día no cambia por la zona horaria
      }
      if (parentId) {
        // El padre de una feature es un portfolio item de nivel superior (Initiative, Epic…, según el Rally).
        const clean = parentId.replace(/[-\s]/g, '').toUpperCase();
        if (!/^[A-Z]{1,3}\d{1,12}$/.test(clean)) throw new ApiError(400, 'El padre de una feature es un portfolio item: indica su ID.');
        const [o] = await this.list(a, '/portfolioitem', { query: `(FormattedID = "${clean}")`, fetch: 'ObjectID', pagesize: '1' });
        const parentRef = o ? this.relative(a, o._ref) : null;
        if (!parentRef) throw new ApiError(404, `${clean} no existe en Rally.`);
        fields.Parent = parentRef;
      }
    } else {
      const flow = ref('flowStateRef', 'flowstate');
      const schedule = text('scheduleState', 40);
      // La columna ya lleva su ScheduleState: mandar los dos podría contradecirse.
      if (flow) fields.FlowState = flow;
      else if (schedule) fields.ScheduleState = schedule;
      const estimate = num('planEstimate');
      if (estimate !== null) fields.PlanEstimate = estimate;
      if (input.expedite === true) fields.Expedite = true;
      if (parentId && type === 'hierarchicalrequirement') {
        fields.Parent = (await this.findByFormattedId(a, parentId, { US: 'hierarchicalrequirement' }, 'El padre de una User Story es otra User Story')).ref;
      }
      if (parentId && type === 'defect') {
        fields.Requirement = (await this.findByFormattedId(a, parentId, { US: 'hierarchicalrequirement' }, 'El defecto se enlaza con una User Story')).ref;
      }
      const featureId = String(input.featureId ?? '').trim();
      if (featureId && type === 'hierarchicalrequirement') {
        fields.PortfolioItem = (await this.findByFormattedId(a, featureId, { F: 'portfolioitem/feature' }, 'La feature')).ref;
      }
      if (type === 'defect') {
        for (const [k, f] of [['severity', 'Severity'], ['priority', 'Priority'], ['state', 'State'], ['environment', 'Environment']]) {
          const v = text(k, 100);
          if (v) fields[f] = v;
        }
      }
    }
    if (!/^\d+$/.test(projectId)) throw new ApiError(400, 'Elige el proyecto de Rally.');
    fields.Project = `/project/${projectId}`;
    const custom = input.custom && typeof input.custom === 'object' ? input.custom as Record<string, unknown> : {};
    for (const [k, v] of Object.entries(custom).slice(0, 50)) {
      if (!/^c_\w{1,80}$/.test(k)) throw new ApiError(400, `Campo personalizado no válido: ${k}.`);
      const value = String(v ?? '').trim().slice(0, 30_000);
      if (value) fields[k] = value;
    }

    const assignee = ref('assigneeRef', 'user') ?? (input.assignToMe === true ? `/user/${a.rally_user_id}` : null);
    const send = (body: RallyObject) => this.post(a, `/${type}/create?fetch=${FETCH}`, { [info.typeName]: body });
    let created: RallyObject;
    if (assignee && info.assignee) {
      created = await send({ ...fields, [ASSIGNEE_FIELD]: assignee }).catch((e: unknown) => {
        if (e instanceof ApiError && e.message.includes(ASSIGNEE_FIELD)) return send(fields);
        throw e;
      });
    } else {
      created = await send(fields);
    }
    return toRallyItem({ _type: type, ...created }, a.base_url, a.rally_user_id)!;
  }

  /** Publica un comentario en la discusión de un elemento, como el usuario de la clave. */
  async comment(user: TeamUser, input: { kind?: unknown; objectId?: unknown; text?: unknown }): Promise<RallyDetail['discussion'][number]> {
    const a = await this.connected(user);
    const entry = Object.entries(KINDS).find(([, info]) => info.kind === input.kind);
    if (!entry || !/^\d+$/.test(String(input.objectId))) throw new ApiError(400, 'Elemento de Rally no válido.');
    const text = String(input.text ?? '').trim();
    if (!text) throw new ApiError(400, 'Escribe el comentario.');
    if (text.length > 10_000) throw new ApiError(400, 'El comentario es demasiado largo.');
    const post = await this.post(a, '/conversationpost/create?fetch=Text,User,CreationDate',
      { ConversationPost: { Artifact: `/${entry[0]}/${input.objectId}`, Text: commentHtml(text) } });
    return {
      author: refName(post.User) ?? a.rally_user,
      date: String(post.CreationDate ?? new Date().toISOString()),
      text: htmlToText(String(post.Text ?? commentHtml(text))),
    };
  }

  /**
   * Adjunta un archivo a un elemento. Rally lo pide en dos pasos: primero el contenido (en base64) y después el adjunto
   * que lo enlaza con el elemento, con su nombre, tipo y tamaño.
   */
  async attach(user: TeamUser, input: { kind?: unknown; objectId?: unknown; name?: unknown; contentType?: unknown; content?: unknown }):
    Promise<RallyDetail['attachments'][number]> {
    const a = await this.connected(user);
    const entry = Object.entries(KINDS).find(([, info]) => info.kind === input.kind);
    if (!entry || !/^\d+$/.test(String(input.objectId))) throw new ApiError(400, 'Elemento de Rally no válido.');
    const name = String(input.name ?? '').split(/[\\/]/).pop()!.trim().slice(0, 250);
    const content = String(input.content ?? '');
    if (!name || !content || !/^[A-Za-z0-9+/]+=*$/.test(content)) throw new ApiError(400, 'Archivo no válido.');
    const size = Buffer.from(content, 'base64').length;
    if (!size) throw new ApiError(400, 'El archivo está vacío.');
    if (size > MAX_ATTACHMENT_BYTES) throw new ApiError(400, 'El archivo pasa de 25 MB: adjúntalo directamente en Rally.');
    const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(String(input.contentType ?? '')) ? String(input.contentType) : 'application/octet-stream';
    const stored = await this.post(a, '/attachmentcontent/create', { AttachmentContent: { Content: content } });
    const ref = this.relative(a, stored._ref) ?? `/attachmentcontent/${String(stored.ObjectID ?? '')}`;
    const file = await this.post(a, '/attachment/create?fetch=Name,Size',
      { Attachment: { Artifact: `/${entry[0]}/${input.objectId}`, Content: ref, ContentType: contentType, Name: name, Size: size } });
    return { name: String(file.Name ?? name), size: Number(file.Size ?? size) };
  }

  /** Nombre visible de cada campo de un tipo (ElementName → Name), en caché por servidor y tipo. */
  private labels = new Map<string, Promise<Map<string, string>>>();
  private fieldLabels(a: { base_url: string; api_key: string }, typeName: string) {
    const key = `${a.base_url} ${typeName}`;
    if (!this.labels.has(key)) {
      const load = (async () => {
        const def = ((await this.get(a.base_url, a.api_key, `/typedefinition?query=${encodeURIComponent(`(ElementName = ${typeName})`)}&fetch=Attributes`))
          .QueryResult as RallyObject)?.Results as RallyObject[] | undefined;
        const ref = this.relative(a, (def?.[0]?.Attributes as RallyObject | undefined)?._ref);
        const attrs = ref ? await this.collection(a, ref, 'Name,ElementName') : [];
        return new Map(attrs.map((x) => [String(x.ElementName), String(x.Name)]));
      })();
      load.catch(() => this.labels.delete(key)); // si falla, se reintenta la próxima vez
      this.labels.set(key, load);
    }
    return this.labels.get(key)!;
  }

  /** Ruta relativa a la WSAPI de una referencia de Rally (solo del mismo servidor). */
  private relative(a: { base_url: string }, ref: unknown): string | null {
    const prefix = `${a.base_url}/slm/webservice/v2.0`;
    return typeof ref === 'string' && ref.startsWith(`${prefix}/`) ? ref.slice(prefix.length) : null;
  }

  private async collection(a: { base_url: string; api_key: string }, ref: string, fetchFields: string, order?: string): Promise<RallyObject[]> {
    const params = new URLSearchParams({ fetch: fetchFields, pagesize: String(PAGE), ...(order ? { order } : {}) });
    return (((await this.get(a.base_url, a.api_key, `${ref}?${params}`)).QueryResult as RallyObject)?.Results ?? []) as RallyObject[];
  }

  /** Ficha completa de un elemento: todos los campos con valor, textos, etiquetas, hijos, discusión y adjuntos. */
  async detail(user: TeamUser, kind: unknown, objectId: unknown): Promise<RallyDetail> {
    const a = await this.connected(user);
    const entry = Object.entries(KINDS).find(([, info]) => info.kind === kind);
    if (!entry || !/^\d+$/.test(String(objectId))) throw new ApiError(400, 'Elemento de Rally no válido.');
    const [type, info] = entry;
    const [o, labels] = await Promise.all([
      this.get(a.base_url, a.api_key, `/${type}/${objectId}?fetch=true`).then((r) => r[info.typeName] as RallyObject | undefined),
      this.fieldLabels(a, info.typeName).catch(() => new Map<string, string>()),
    ]);
    if (!o) throw new ApiError(404, 'Ese elemento ya no existe en Rally.');
    const item = toRallyItem({ _type: type, ...o }, a.base_url, a.rally_user_id)!;
    const label = (k: string) => labels.get(k) ?? k.replace(/^c_/, '');

    const fields: RallyDetail['fields'] = [];
    const texts: RallyDetail['texts'] = [];
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_') || HIDDEN.has(k)) continue;
      if (typeof v === 'string' && (isHtml(v) || v.length > 120 || k === 'Description' || k === 'Notes')) {
        const text = htmlToText(v);
        if (text) texts.push({ label: label(k), text });
        continue;
      }
      const value = fieldValue(v);
      if (value !== null) fields.push({ label: label(k), value });
    }
    // Descripción y notas primero, como en Rally.
    const first = [label('Description'), label('Notes')];
    texts.sort((x, y) => (first.indexOf(x.label) + 1 || 9) - (first.indexOf(y.label) + 1 || 9));
    fields.sort((x, y) => x.label.localeCompare(y.label, 'es'));

    const sub = (k: string) => {
      const c = o[k] as RallyObject | undefined;
      return c && Number(c.Count) > 0 ? this.relative(a, c._ref) : null;
    };
    const fetchSub = (k: string, fetchFields: string, order?: string) => {
      const ref = sub(k);
      return ref ? this.collection(a, ref, fetchFields, order).catch(() => []) : Promise.resolve([] as RallyObject[]);
    };
    const [tags, posts, files, ...lists] = await Promise.all([
      fetchSub('Tags', 'Name'),
      fetchSub('Discussion', 'Text,User,CreationDate', 'CreationDate'),
      fetchSub('Attachments', 'Name,Size'),
      ...RELATED.map(([k]) => fetchSub(k, FETCH)),
    ]);
    return {
      item,
      blockedReason: item.blocked ? String(o.BlockedReason ?? '') || null : null,
      fields,
      texts,
      tags: tags.map((t) => String(t.Name ?? '')).filter(Boolean),
      related: RELATED.map(([, l], i) => ({
        label: l,
        items: lists[i].map((r) => toRallyItem(r, a.base_url, a.rally_user_id)).filter((x): x is RallyItem => !!x),
      })).filter((g) => g.items.length),
      discussion: posts.map((p) => ({ author: refName(p.User), date: String(p.CreationDate ?? ''), text: htmlToText(String(p.Text ?? '')) })),
      attachments: files.map((f) => ({ name: String(f.Name ?? ''), size: Number(f.Size ?? 0) })),
    };
  }

  private async query(a: { base_url: string; api_key: string }, type: string, query: string): Promise<RallyObject[]> {
    return (await this.queryAll(a, type, query)).rows;
  }

  /**
   * Todas las páginas de una consulta (más reciente primero), hasta `MAX_PAGES` × 200. La primera dice cuántos hay y
   * las demás se piden de 5 en 5 a la vez, para no tardar. `total` es lo que hay en Rally (puede ser más que `rows`).
   */
  private async queryAll(a: { base_url: string; api_key: string }, type: string, query: string): Promise<{ rows: RallyObject[]; total: number }> {
    const page = async (n: number) => {
      const params = new URLSearchParams({ query, fetch: FETCH, order: 'LastUpdateDate DESC', pagesize: String(PAGE), start: String(n * PAGE + 1) });
      return (await this.get(a.base_url, a.api_key, `/${type}?${params}`)).QueryResult as RallyObject;
    };
    const first = await page(0);
    const rows = [...((first?.Results ?? []) as RallyObject[])];
    const total = Number(first?.TotalResultCount ?? rows.length);
    const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE));
    for (let n = 1; n < pages && rows.length === n * PAGE; n += 5) {
      const batch = await Promise.all(Array.from({ length: Math.min(5, pages - n) }, (_, i) => page(n + i)));
      for (const r of batch) rows.push(...((r?.Results ?? []) as RallyObject[]));
    }
    return { rows, total };
  }
}
