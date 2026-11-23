import { useSyncExternalStore } from 'react';
import { extDocs } from '../mslist/extension';

/**
 * Textos de los documentos de la carpeta de SharePoint del Asistente (Word, texto, Markdown, CSV, HTML), leídos por la
 * extensión para encontrarlos al momento, sin esperar al buscador de SharePoint. En memoria durante la sesión; al volver a
 * leer, solo se descargan los que han cambiado.
 */
export interface FolderDoc { url: string; name: string; modified: string; folder: string; text: string }

interface State { folder: string | null; docs: FolderDoc[]; loading: boolean; error: string | null; total: number }

let state: State = { folder: null, docs: [], loading: false, error: null, total: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useFolderDocs = () => useSyncExternalStore(subscribe, () => state);

type Reply = { files: ({ url: string; unchanged: true } | FolderDoc)[]; total: number };

export async function loadFolderDocs(siteUrl: string, folder: string) {
  if (state.loading) return;
  const same = state.folder === folder;
  const previous = same ? state.docs : [];
  set({ loading: true, error: null, folder, ...(same ? {} : { docs: [], total: 0 }) });
  try {
    const known = Object.fromEntries(previous.map((d) => [d.url, d.modified]));
    const r = await extDocs<Reply>('texts', { siteUrl, folder, known }, 240_000);
    const byUrl = new Map(previous.map((d) => [d.url, d]));
    const docs = r.files.map((f) => ('unchanged' in f ? byUrl.get(f.url) : f)).filter((d): d is FolderDoc => !!d && !!d.text);
    set({ docs, total: r.total, loading: false });
  } catch (e) {
    set({ loading: false, error: (e as Error).message });
  }
}
