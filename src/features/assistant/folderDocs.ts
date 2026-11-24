import { useSyncExternalStore } from 'react';
import { extDocs } from '../mslist/extension';

/**
 * Textos de los documentos de las carpetas de SharePoint del Asistente (Word, texto, Markdown, CSV, HTML), leídos por la
 * extensión para encontrarlos al momento, sin esperar al buscador de SharePoint. Uno por carpeta (pueden ser de sitios
 * distintos: WPP, La Caixa…), en memoria durante la sesión; al volver a leer, solo se descargan los que han cambiado.
 */
export interface FolderDoc { url: string; name: string; modified: string; folder: string; text: string }
export interface FolderState { docs: FolderDoc[]; loading: boolean; error: string | null; total: number }

export const folderKey = (siteUrl: string, folder: string) => `${siteUrl}|${folder}`;
const EMPTY: FolderState = { docs: [], loading: false, error: null, total: 0 };

let state: Record<string, FolderState> = {};
const listeners = new Set<() => void>();
const set = (key: string, patch: Partial<FolderState>) => {
  state = { ...state, [key]: { ...(state[key] ?? EMPTY), ...patch } };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useFolderDocs = () => useSyncExternalStore(subscribe, () => state);
export const folderState = (all: Record<string, FolderState>, siteUrl: string, folder: string) => all[folderKey(siteUrl, folder)] ?? EMPTY;

type Reply = { files: ({ url: string; unchanged: true } | FolderDoc)[]; total: number };

export async function loadFolderDocs(siteUrl: string, folder: string) {
  const key = folderKey(siteUrl, folder);
  const current = state[key] ?? EMPTY;
  if (current.loading) return;
  set(key, { loading: true, error: null });
  try {
    const known = Object.fromEntries(current.docs.map((d) => [d.url, d.modified]));
    const r = await extDocs<Reply>('texts', { siteUrl, folder, known }, 240_000);
    const byUrl = new Map(current.docs.map((d) => [d.url, d]));
    const docs = r.files.map((f) => ('unchanged' in f ? byUrl.get(f.url) : f)).filter((d): d is FolderDoc => !!d && !!d.text);
    set(key, { docs, total: r.total, loading: false });
  } catch (e) {
    set(key, { loading: false, error: (e as Error).message });
  }
}
