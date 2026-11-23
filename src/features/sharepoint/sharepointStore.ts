import { useSyncExternalStore } from 'react';
import { BRIDGE_VERSION } from './bookmarklet';
import { folderLocation, isSharePointOrigin, parseSnapshot, type SharePointFolder, type SharePointSnapshot } from '../../domain/sharepoint';

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
}
let state: State = { snapshot: null, error: null, loading: false, connected: false, waitingFor: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSharePointSnapshot = () => useSyncExternalStore(subscribe, () => state);
/** Estado actual (para los tests). */
export const sharePointState = () => state;

export const setSnapshot = (s: SharePointSnapshot | null) => set({ snapshot: s, error: null, loading: false });
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
  set({ loading: true, error: null });
  try {
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

/** Un PDF o una imagen, como `blob:` de esta pestaña (quien lo pide revoca la URL al cerrar la vista previa). */
export async function loadFile(path: string, type: string, maxBytes: number): Promise<string> {
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
