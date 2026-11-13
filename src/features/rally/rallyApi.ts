import type { RallyCategory, RallyCreatableKind, RallyCreateInput, RallyDetail, RallyFormOptions, RallyItem, RallyKind, RallyPick, RallyProject, RallyRef, RallyStatus } from '../../domain/rally';
import { LOCAL_SERVER, serverCall as call } from '../../data/serverApi';


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
    }).then((r) => r.item),
  lookup: (ids: string[]) => call<{ items: RallyItem[] }>('POST', '/api/rally/lookup', { ids }).then((r) => r.items),
  detail: (item: RallyItem) => call<RallyDetail>('GET', `/api/rally/detail?kind=${item.kind}&id=${item.objectId}`),
  create: (input: RallyCreateInput | { kind: 'TA'; name: string; parentId: string; assignToMe: boolean }) =>
    call<{ item: RallyItem }>('POST', '/api/rally/create', input).then((r) => r.item),
  searchUsers: (q: string) => call<{ users: RallyRef[] }>('GET', `/api/rally/users?q=${encodeURIComponent(q)}`).then((r) => r.users),
  pick: (filter: { types: string[]; q: string; project: string; release: string; page: number }) =>
    call<{ items: RallyPick[]; total: number }>('GET', `/api/rally/pick?${new URLSearchParams({ ...filter, types: filter.types.join(','), page: String(filter.page) })}`),
  tags: (q: string, page: number) => call<{ items: RallyRef[]; total: number }>('GET', `/api/rally/tags?q=${encodeURIComponent(q)}&page=${page}`),
  formOptions: (kind: RallyCreatableKind, projectId: string) =>
    call<RallyFormOptions>('GET', `/api/rally/form?kind=${kind}&project=${projectId}`),
  /** Botones Ready y Blocked (sin cambiar de columna). `reason`: motivo al bloquear (el texto del comentario). */
  flag: (id: string, change: { ready?: boolean; blocked?: boolean; reason?: string }) =>
    call<{ item: RallyItem }>('POST', '/api/rally/flag', { id, ...change }).then((r) => r.item),
  /** Mensaje en la discusión; las personas de `mentions` que salgan como «@Nombre» se mencionan (avisa por correo). */
  message: (id: string, text: string, mentions: RallyRef[]) =>
    call<{ mentioned: string[] }>('POST', '/api/rally/message', { id, text, mentions }),
  /** TS a Need Review a la vez: columna, Blocked con motivo y comentario con PO, defecto y analista. */
  needReview: (input: { id: string; defectId: string; text: string; analyst: RallyRef; reason: string }) =>
    call<{ item: RallyItem; owner: string | null; analyst: string; commentError?: string }>('POST', '/api/rally/need-review', input),
  /** Comentario de un movimiento con el Owner (PO) y, si se elige, el analista. */
  moveComment: (id: string, text: string, analyst: RallyRef | null) =>
    call<{ text: string; owner: string | null; analyst: string | null; people?: { name: string; email: string | null }[] }>('POST', '/api/rally/move-comment', { id, text, analyst }),
  comment: (item: RallyItem, text: string) =>
    call<{ post: RallyDetail['discussion'][number] }>('POST', '/api/rally/comment', { kind: item.kind, objectId: item.objectId, text }).then((r) => r.post),
  attach: (item: RallyItem, file: { name: string; contentType: string; content: string }) =>
    call<{ file: RallyDetail['attachments'][number] }>('POST', '/api/rally/attach', { kind: item.kind, objectId: item.objectId, ...file }).then((r) => r.file),
  projects: () => call<{ projects: RallyProject[] }>('GET', '/api/rally/projects').then((r) => r.projects),
  items: (days: number, projects: string[], tags: string[] = []) =>
    call<{ items: RallyItem[]; truncated: { kind: RallyKind; total: number; shown: number }[] }>('GET', `/api/rally/items?${new URLSearchParams([['days', String(days)], ['projects', projects.join(',')], ...tags.map((t) => ['tag', t])])}`)

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
