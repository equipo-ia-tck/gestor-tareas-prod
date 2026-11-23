import { useSyncExternalStore } from 'react';
import type { MsListChange, MsListResult } from '../../domain/msListParse';

/**
 * La extensión de Chrome «Marea · Lista» (carpeta `extension/`): su `content.js` se mete en las páginas de Marea y
 * contesta por `postMessage` (mismo origen). Con ella, Marea sincroniza la lista sin tener SharePoint abierto.
 */

/** Versión de `extension/manifest.json` (un test comprueba que coinciden): si la instalada es anterior, se avisa. */
export const LATEST_EXTENSION = '1.1.0';

/** ¿La versión instalada es anterior a la última? */
export function isOutdated(installed: string | null): boolean {
  if (!installed) return false;
  const a = installed.split('.').map(Number);
  const b = LATEST_EXTENSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

let version: string | null = null;
const listeners = new Set<() => void>();
const waiting = new Map<string, { resolve: (r: ExtResult) => void; timer: ReturnType<typeof setTimeout> }>();

export interface ExtResult { list?: unknown; results?: MsListResult[]; via?: 'background' | 'tab'; error?: string }

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin || !e.data || typeof e.data !== 'object') return;
    const d = e.data as Record<string, unknown>;
    if (d.type === 'marea-ext:hello' && typeof d.version === 'string') {
      if (version !== d.version) { version = d.version; for (const l of listeners) l(); }
    } else if (d.type === 'marea-ext:result' && typeof d.id === 'string') {
      const w = waiting.get(d.id);
      if (!w) return;
      waiting.delete(d.id);
      clearTimeout(w.timer);
      w.resolve(d as ExtResult);
    }
  });
  // Por si el puente se ha cargado antes que Marea y su «hola» se ha perdido.
  window.postMessage({ type: 'marea-ext:ping' }, window.location.origin);
}

export const extensionVersion = () => version;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Versión de la extensión instalada, o null. */
export const useExtension = () => useSyncExternalStore(subscribe, extensionVersion);

/** Pide a la extensión aplicar los cambios y, si se aplica alguno o se pide, leer la lista. */
export function extSync(listUrl: string, changes: MsListChange[], wantList: boolean): Promise<ExtResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    // Leer una lista grande o abrir la pestaña de SharePoint puede tardar.
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'La extensión no ha contestado a tiempo.' }); }, 180_000);
    waiting.set(id, { resolve, timer });
    window.postMessage({ type: 'marea-ext:sync', id, listUrl, changes, wantList }, window.location.origin);
  });
}
