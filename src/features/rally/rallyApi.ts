import type { RallyCategory, RallyCc, RallyCreatableKind, RallyCreateInput, RallyDetail, RallyFormOptions, RallyItem, RallyKind, RallyPick, RallyProject, RallyRef, RallyStatus, RallyUpdateInput } from '../../domain/rally';
import { LOCAL_SERVER, serverCall as call } from '../../data/serverApi';
import { sync } from '../../data/sync';
import { artifactHash, type RallyActivity, type ToolEventKind } from '../../domain/rallyActivity';
import { track } from '../usage/track';

/**
 * Apunta que la herramienta ha escrito en Rally (tipo y huella del elemento), para saber en la analítica qué cambios de
 * Rally salen de aquí. Solo si ha ido bien; nunca molesta si falla.
 */
const mark = (id: string, ...kinds: ToolEventKind[]) => {
  if (!id) return;
  void artifactHash(id).then((h) => { for (const k of kinds) sync().logRallyTool(k, h); }).catch(() => undefined);
};

/** Apunta en la analítica lo que se ha hecho en Rally (solo si ha ido bien). */
const done = (name: string, detail = '') => <T,>(r: T) => { track(name, detail); return r; };


/** Conector de Rally del servidor (`servidor/rally.ts`): la clave nunca llega al navegador. */
export const rallyApi = {
  status: () => call<RallyStatus>('GET', '/api/rally'),
  connect: (apiKey: string, baseUrl: string) => call<RallyStatus>('POST', '/api/rally/connect', { apiKey, baseUrl }),
  disconnect: () => call<RallyStatus>('POST', '/api/rally/disconnect', {}),
  /**
   * Mueve a la columna de la categoría, o a `flow` (nombre de la columna: «Need Review») si el proyecto la tiene.
   * `dryRun`: no escribe, solo dice cómo quedaría y el comentario. `blockedReason`: motivo al bloquear.
   */
  move: (id: string, category: RallyCategory, opts: { dryRun?: boolean; blockedReason?: string; flow?: string } = {}) =>
    call<{ item: RallyItem }>('POST', '/api/rally/move', {
      id, category, ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.blockedReason ? { blockedReason: opts.blockedReason } : {}),
      ...(opts.flow ? { flow: opts.flow } : {}),
    }).then((r) => { if (!opts.dryRun) { track('rally-move', category); mark(id, 'change'); } return r.item; }),
  lookup: (ids: string[]) => call<{ items: RallyItem[] }>('POST', '/api/rally/lookup', { ids }).then((r) => r.items),
  detail: (item: RallyItem) => call<RallyDetail>('GET', `/api/rally/detail?kind=${item.kind}&id=${item.objectId}`),
  create: (input: RallyCreateInput | { kind: 'TA'; name: string; parentId: string; assignToMe: boolean }) =>
    call<{ item: RallyItem }>('POST', '/api/rally/create', input).then((r) => { mark(r.item.id, 'create'); return r.item; }),
  searchUsers: (q: string) => call<{ users: RallyRef[] }>('GET', `/api/rally/users?q=${encodeURIComponent(q)}`).then((r) => r.users),
  pick: (filter: { types: string[]; q: string; project: string; release: string; page: number }) =>
    call<{ items: RallyPick[]; total: number }>('GET', `/api/rally/pick?${new URLSearchParams({ ...filter, types: filter.types.join(','), page: String(filter.page) })}`),
  tags: (q: string, page: number) => call<{ items: RallyRef[]; total: number }>('GET', `/api/rally/tags?q=${encodeURIComponent(q)}&page=${page}`),
  /** `ruleFields`: campos que piden las reglas de trabajo del proyecto (se recuerdan tras un error al crear). */
  formOptions: (kind: RallyCreatableKind, projectId: string, ruleFields: string[] = []) =>
    call<RallyFormOptions>('GET', `/api/rally/form?${new URLSearchParams([['kind', kind], ['project', projectId], ...ruleFields.map((f) => ['rule', f])])}`),
  /** Guarda los campos cambiados en la ficha (sin los estados) y devuelve la ficha nueva. */
  update: (item: RallyItem, changes: RallyUpdateInput) =>
    call<RallyDetail>('POST', '/api/rally/update', { kind: item.kind, objectId: item.objectId, changes }).then(done('rally-edit')).then((d) => { mark(item.id, 'change'); return d; }),
  /** Botones Ready y Blocked (sin cambiar de columna). `reason`: motivo al bloquear (el texto del comentario). */
  flag: (id: string, change: { ready?: boolean; blocked?: boolean; reason?: string }) =>
    call<{ item: RallyItem }>('POST', '/api/rally/flag', { id, ...change }).then((r) => { mark(id, 'change'); return r.item; }),
  /** Mensaje en la discusión; las personas de `mentions` que salgan como «@Nombre» se mencionan (avisa por correo). */
  message: (id: string, text: string, mentions: RallyRef[]) =>
    call<{ mentioned: string[] }>('POST', '/api/rally/message', { id, text, mentions }).then(done('rally-comment', 'message')).then((r) => { mark(id, 'comment'); return r; }),
  /** TS a Need Review a la vez: columna, Blocked con motivo y comentario con PO IT, defecto y CC (analista y más). */
  needReview: (input: { id: string; defectId: string; text: string; reason: string; owner: RallyRef | null; noOwner: boolean; cc: RallyCc[] }) =>
    call<{ item: RallyItem; owner: string | null; analyst: string | null; cc: string[]; commentError?: string }>('POST', '/api/rally/need-review', input).then(done('rally-comment', 'need-review'))
      .then((r) => { if (r.commentError) mark(input.id, 'change'); else mark(input.id, 'change', 'comment'); return r; }),
  /**
   * Comentario de un movimiento (o de Blocked / quitar Ready): «@Persona texto» + «CC: …». `owner`: otra persona en lugar
   * del Owner; `noOwner`: no mencionar a nadie primero; `cc`: analista y demás.
   */
  moveComment: (id: string, text: string, people: { owner: RallyRef | null; noOwner: boolean; cc: RallyCc[] }) =>
    call<{ text: string; owner: string | null; cc: string[]; people?: { name: string; email: string | null }[] }>('POST', '/api/rally/move-comment', { id, text, ...people }).then(done('rally-comment', 'move')).then((r) => { mark(id, 'comment'); return r; }),
  comment: (item: RallyItem, text: string, mentions: RallyRef[] = []) =>
    call<{ post: RallyDetail['discussion'][number] }>('POST', '/api/rally/comment', { kind: item.kind, objectId: item.objectId, text, mentions }).then(done('rally-comment', 'free')).then((r) => { mark(item.id, 'comment'); return r.post; }),
  /** Cambia el texto de un comentario propio (las menciones que tenía se conservan). */
  editComment: (objectId: string, text: string) =>
    call<{ post: RallyDetail['discussion'][number] }>('POST', '/api/rally/comment-edit', { objectId, text }).then(done('rally-comment-edit')).then((r) => r.post),
  /** Elimina un comentario propio de la discusión (no se puede deshacer). */
  deleteComment: (objectId: string) => call<{ ok: boolean }>('POST', '/api/rally/comment-delete', { objectId }).then(done('rally-comment-delete')),
  attach: (item: RallyItem, file: { name: string; contentType: string; content: string }) =>
    call<{ file: RallyDetail['attachments'][number] }>('POST', '/api/rally/attach', { kind: item.kind, objectId: item.objectId, ...file }).then(done('rally-attach')).then((r) => { mark(item.id, 'attachment'); return r.file; }),
  /** Elimina un adjunto en Rally (no se puede deshacer). */
  deleteAttachment: (objectId: string) => call<{ ok: boolean }>('POST', '/api/rally/attachment-delete', { objectId }).then(done('rally-attach-delete')),
  projects: () => call<{ projects: RallyProject[] }>('GET', '/api/rally/projects').then((r) => r.projects),
  /** `scope`: sumar los proyectos hijos (`down`) y padres (`up`) de los elegidos, como en Rally. */
  items: (days: number, projects: string[], tags: string[] = [], scope: { down: boolean; up: boolean } = { down: false, up: false }) =>
    call<{ items: RallyItem[]; truncated: { kind: RallyKind; total: number; shown: number }[] }>('GET', `/api/rally/items?${new URLSearchParams([
      ['days', String(days)], ['projects', projects.join(',')], ...tags.map((t) => ['tag', t]), ['down', scope.down ? '1' : '0'], ['up', scope.up ? '1' : '0'],
    ])}`),
  /** Cambios hechos en Rally en un periodo (instantes ISO) y unos proyectos, para la analítica (herramienta frente a Rally). */
  activity: (from: string, to: string, projects: string[], scope: { down: boolean; up: boolean }) =>
    call<RallyActivity>('GET', `/api/rally/activity?${new URLSearchParams({ from, to, projects: projects.join(','), down: scope.down ? '1' : '0', up: scope.up ? '1' : '0' })}`),
};

/** Contenido de un archivo en base64 (sin la cabecera `data:…;base64,`). */
export const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(new Error(`No se ha podido leer ${file.name}.`));
  reader.readAsDataURL(file);
});

/**
 * Tamaño máximo de un adjunto. En local, el del servidor (`MAX_ATTACHMENT_BYTES`, 25 MB). En Vercel cada petición admite
 * 4,5 MB y el archivo viaja en base64 (un tercio más), así que 3 MB.
 */
export const MAX_UPLOAD = (LOCAL_SERVER ? 25 : 3) * 1024 * 1024;
export const MAX_UPLOAD_LABEL = LOCAL_SERVER ? '25 MB' : '3 MB';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;

/** Aviso de un adjunto demasiado grande: qué archivo, cuánto pesa y qué hacer. */
export const tooBigMessage = (file: File) =>
  `«${file.name}» pesa ${mb(file.size)} y aquí el máximo es ${MAX_UPLOAD_LABEL}: ${LOCAL_SERVER ? 'adjúntalo directamente en Rally' : 'adjúntalo en Rally o desde la versión local (localhost:4173)'}.`;
