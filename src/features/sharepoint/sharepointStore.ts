import { useSyncExternalStore } from 'react';
import { BRIDGE_VERSION } from './bookmarklet';
import { extDocs, extensionVersion, isOutdated } from '../mslist/extension';
import { folderLocation, isSharePointOrigin, parseSnapshot, sharePointTarget, type SharePointFolder, type SharePointSnapshot } from '../../domain/sharepoint';

/**
 * Lo que manda el marcador, **solo en memoria** de esta pestaña (a propósito: son datos de CaixaBank). No se guarda en
 * Supabase, IndexedDB ni localStorage; al recargar o cerrar la pestaña desaparece. Mientras la pestaña de SharePoint del
 * marcador siga abierta, hace de puente: se le piden otras carpetas (navegar) y PDF o imágenes (vista previa).
 */
interface State {
  snapshot: SharePointSnapshot | null;
  error: string | null;
  loading: boolean;
  connected: boolean;
  /** Carpeta guardada que se quiere ver y espera a que se conecte el puente. */
  waitingFor: (SharePointFolder & { origin: string; path: string }) | null;
  /** De dónde sale la carpeta que se ve: la extensión de Chrome (sin pestaña de SharePoint) o el marcador. */
  via: 'extension' | 'bridge' | null;
  /** Archivo que hay que marcar (y ver, si se puede) al abrir su carpeta desde un enlace (p. ej. de la discusión de Rally). */
  focus: string | null;
}
let state: State = { snapshot: null, error: null, loading: false, connected: false, waitingFor: null, via: null, focus: null };
/** Sitio (dirección completa) de la carpeta abierta con la extensión. */
let extSite: string | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSharePointSnapshot = () => useSyncExternalStore(subscribe, () => state);
/** Estado actual (para los tests). */
export const sharePointState = () => state;

export const setSnapshot = (s: SharePointSnapshot | null) => set({ snapshot: s, error: null, loading: false, ...(s ? {} : { via: null }) });
export const setSnapshotError = (message: string | null) => set({ error: message, loading: false });

export const OLD_BOOKMARKLET = 'El marcador de tu barra es de una versión anterior. Bórralo (clic derecho → Eliminar) y vuelve a '
  + 'arrastrar «Marea · Carpeta» desde esta pantalla; después púlsalo otra vez en SharePoint.';

/** La pestaña de SharePoint que hace de puente (la que pulsó el marcador). */
let bridge: { win: Window; origin: string } | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function ask<T>(message: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  if (!bridge || bridge.win.closed) {
    bridge = null;
    set({ connected: false });
    return Promise.reject(new Error('La pestaña de SharePoint del marcador se ha cerrado: vuelve a pulsar el marcador.'));
  }
  const request = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(request); reject(new Error('SharePoint no contesta. ¿Sigue abierta su pestaña? Vuelve a pulsar el marcador.')); }, timeoutMs);
    waiting.set(request, { resolve: resolve as (v: unknown) => void, reject, timer });
    bridge!.win.postMessage({ ...message, request }, bridge!.origin);
  });
}

/** Abre otra carpeta del mismo sitio sin salir de Marea. */
export async function openFolder(path: string) {
  set({ loading: true, error: null, focus: null });
  try {
    if (state.via === 'extension' && extSite) { await extensionFolder(extSite, path); return; }
    const snap = await ask<SharePointSnapshot>({ type: 'marea-sp:list', path });
    set({ snapshot: snap, loading: false });
  } catch (e) {
    set({ error: (e as Error).message, loading: false });
  }
}

/**
 * Ver una carpeta guardada dentro de Marea. Con el puente conectado a ese SharePoint, se abre al momento; si no, queda
 * esperando (`waitingFor`) y se abre sola en cuanto se pulsa el marcador. Devuelve false si el enlace no dice qué carpeta
 * es (entonces se abre en SharePoint).
 */
export function showFolder(folder: SharePointFolder): boolean {
  const where = folderLocation(folder.url);
  if (!where) return false;
  if (bridge && !bridge.win.closed && bridge.origin === where.origin) {
    set({ waitingFor: null });
    void openFolder(where.path);
  } else {
    set({ waitingFor: { ...folder, ...where }, error: null });
  }
  return true;
}

/**
 * «Conectar»: abre la carpeta en SharePoint en otra pestaña **sin** cortar el enlace con esta (sin `noopener`), para que el
 * marcador, al pulsarlo allí, hable con esta misma pestaña de Marea y no abra otra.
 */
export function openForBridge(url: string) {
  window.open(url, '_blank');
}

export const cancelWaiting = () => set({ waitingFor: null });

/** ¿Está instalada la extensión «Marea · Lista» con las operaciones de carpetas (1.5.0 o posterior)? */
export const extensionReady = () => { const v = extensionVersion(); return !!v && !isOutdated(v); };

/** Lee una carpeta con la extensión y la enseña (validada como lo del marcador). */
async function extensionFolder(siteUrl: string, folder: string) {
  const raw = await extDocs<unknown>('folder', { siteUrl, folder }, 90_000);
  const snap = parseSnapshot(raw);
  if (!snap) throw new Error('Lo que ha llegado de SharePoint no es válido.');
  extSite = siteUrl;
  set({ snapshot: snap, loading: false, error: null, via: 'extension', connected: true, waitingFor: null });
}

/**
 * Abre una carpeta (su enlace, también los de «compartir») con la extensión de Chrome: sin pestaña de SharePoint ni
 * marcador. La extensión la resuelve con la sesión de SharePoint de Chrome y la lee.
 */
export async function openWithExtension(url: string) {
  set({ loading: true, error: null, waitingFor: null });
  try {
    const where = await extDocs<{ siteUrl: string; folder: string }>('resolve', { url }, 90_000);
    await extensionFolder(where.siteUrl, where.folder);
  } catch (e) {
    set({ error: (e as Error).message, loading: false });
  }
}

/**
 * Abre en la pantalla SharePoint un enlace (de la discusión de Rally, por ejemplo) con la extensión: una carpeta se ve tal
 * cual y un archivo abre su carpeta con él marcado. Devuelve false si no se puede (sin extensión, enlace que no se sabe
 * leer o error de SharePoint): entonces hay que abrirlo en SharePoint.
 */
export async function openSharePointLink(url: string): Promise<boolean> {
  const target = sharePointTarget(url);
  if (!target || !extensionReady()) return false;
  set({ focus: null });
  await openWithExtension(target.kind === 'folder' ? target.url : target.folderUrl);
  if (state.error || !state.snapshot) return false;
  if (target.kind === 'file') set({ focus: target.path });
  return true;
}

/** Tope por archivo al subir (como en el Asistente: va en base64 por la extensión). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface UploadResult { name: string; error: string | null }

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** ¿Se puede subir a la carpeta que se ve? Solo con la extensión (el marcador solo lee). */
export const canUpload = () => state.via === 'extension' && !!extSite && !!state.snapshot;

/**
 * Sube archivos de este ordenador a la carpeta que se ve, con la extensión y la sesión de SharePoint de la persona (lo mismo
 * que «Cargar» en SharePoint; si La Caixa no deja, SharePoint da el error). Nunca sustituye un archivo que ya exista. Al
 * acabar vuelve a leer la carpeta.
 */
export async function uploadFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<UploadResult[]> {
  const site = extSite;
  const folder = state.snapshot?.path;
  if (state.via !== 'extension' || !site || !folder) throw new Error('Para subir archivos abre la carpeta con la extensión de Chrome.');
  const results = await uploadTo(site, folder, files, onProgress);
  // Si mientras tanto se ha cambiado de carpeta, no se pisa la que se ve.
  if (results.some((r) => !r.error) && state.snapshot?.path === folder) await openFolder(folder);
  return results;
}

/** Sube archivos a una carpeta cualquiera de SharePoint con la extensión (de uno en uno; los de más de 15 MB, no). */
export async function uploadTo(siteUrl: string, folder: string, files: File[], onProgress?: (done: number, total: number) => void): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const [i, file] of files.entries()) {
    onProgress?.(i, files.length);
    if (file.size > MAX_UPLOAD_BYTES) { results.push({ name: file.name, error: 'pesa más de 15 MB: súbelo en SharePoint' }); continue; }
    try {
      await extDocs('upload', { siteUrl, folder, name: file.name, base64: toBase64(await file.arrayBuffer()) }, 180_000);
      results.push({ name: file.name, error: null });
    } catch (e) {
      results.push({ name: file.name, error: (e as Error).message });
    }
  }
  onProgress?.(files.length, files.length);
  return results;
}

/**
 * Para elegir carpeta fuera de la pantalla SharePoint (p. ej. al adjuntar en Rally), sin tocar la carpeta que se ve allí:
 * `resolveFolder` (un enlace → sitio y ruta) y `browseFolder` (un nivel, validado como lo demás).
 */
export const resolveFolder = (url: string) => extDocs<{ siteUrl: string; folder: string; folderName: string }>('resolve', { url }, 90_000);
export async function browseFolder(siteUrl: string, folder: string): Promise<SharePointSnapshot> {
  const snap = parseSnapshot(await extDocs<unknown>('folder', { siteUrl, folder }, 90_000));
  if (!snap) throw new Error('Lo que ha llegado de SharePoint no es válido.');
  return snap;
}

/** Un PDF o una imagen, como `blob:` de esta pestaña (quien lo pide revoca la URL al cerrar la vista previa). */
export async function loadFile(path: string, type: string, maxBytes: number): Promise<string> {
  if (state.via === 'extension' && extSite) {
    const r = await extDocs<{ base64: string; size: number }>('file', { siteUrl: extSite, path }, 120_000);
    if (!r || typeof r.base64 !== 'string' || r.size > maxBytes) throw new Error('El archivo no se puede ver aquí: ábrelo en SharePoint.');
    const bin = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bin], { type }));
  }
  const buffer = await ask<ArrayBuffer>({ type: 'marea-sp:file', path }, 60000);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > maxBytes) throw new Error('El archivo no se puede ver aquí: ábrelo en SharePoint.');
  return URL.createObjectURL(new Blob([buffer], { type }));
}

/** Mensajes del marcador: solo de páginas https de *.sharepoint.com, y todo se valida. */
export function handleBridgeMessage(e: MessageEvent) {
  if (!isSharePointOrigin(e.origin) || !e.data || typeof e.data !== 'object') return;
  const data = e.data as { type?: unknown; message?: unknown; request?: unknown; buffer?: unknown };
  const source = e.source as Window | null;
  const pending = typeof data.request === 'number' ? waiting.get(data.request) : undefined;
  // Las respuestas a una petición solo valen del puente al que se le hizo.
  if (pending && (!bridge || source !== bridge.win)) return;
  const settle = (fn: () => void) => { if (pending) { clearTimeout(pending.timer); waiting.delete(data.request as number); } fn(); };

  if (data.type === 'marea-sp:hello' && source) {
    // Un marcador arrastrado antes de un cambio sigue con su código viejo: se avisa en vez de conectarse a medias.
    const v = (e.data as { v?: unknown }).v;
    if (typeof v !== 'number' || v < BRIDGE_VERSION) {
      if (state.error !== OLD_BOOKMARKLET) set({ error: OLD_BOOKMARKLET, connected: false });
      return;
    }
    bridge = { win: source, origin: e.origin };
    set({ connected: true });
    source.postMessage({ type: 'marea-sp:ready' }, e.origin);
  } else if (data.type === 'marea-sp:folder') {
    const snap = parseSnapshot(e.data);
    settle(() => {
      if (pending) { if (snap) pending.resolve(snap); else pending.reject(new Error('Lo que ha llegado de SharePoint no es válido.')); }
      else if (snap) {
        setSnapshot(snap);
        // Se había pedido una carpeta guardada: en cuanto conecta el puente, se abre esa.
        const want = state.waitingFor;
        if (want && bridge && want.origin === bridge.origin) {
          set({ waitingFor: null });
          if (want.path !== snap.path) void openFolder(want.path);
        }
      } else setSnapshotError('Lo que ha llegado de SharePoint no es válido.');
    });
  } else if (data.type === 'marea-sp:filedata' && pending) {
    settle(() => pending.resolve(data.buffer));
  } else if (data.type === 'marea-sp:error') {
    const message = typeof data.message === 'string' ? data.message.slice(0, 300) : 'Error al leer de SharePoint.';
    settle(() => { if (pending) pending.reject(new Error(message)); else setSnapshotError(message); });
  }
}
