import { useSyncExternalStore } from 'react';
import { sync } from '../../data/sync';
import type { KnowledgeDoc } from '../../domain/knowledge';

/**
 * Documentación del Asistente (Supabase, migración 013), cargada una vez por sesión y compartida por las pantallas.
 * `error` dice por qué no se ha podido leer (p. ej. falta la migración): el Asistente sigue buscando en el resto.
 */
interface DocsState { docs: KnowledgeDoc[]; loaded: boolean; loading: boolean; error: string | null }

let state: DocsState = { docs: [], loaded: false, loading: false, error: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<DocsState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function loadDocs(force = false) {
  if (state.loading || (state.loaded && !force)) return;
  set({ loading: true });
  sync().knowledgeDocs().then(
    (docs) => set({ docs, loaded: true, loading: false, error: null }),
    (e: Error) => set({ loaded: true, loading: false, error: e.message }),
  );
}

export function useDocs(): DocsState {
  const s = useSyncExternalStore(subscribe, () => state);
  if (!s.loaded && !s.loading) queueMicrotask(() => loadDocs());
  return s;
}

export async function saveDoc(d: Parameters<ReturnType<typeof sync>['saveKnowledgeDoc']>[0]) {
  const saved = await sync().saveKnowledgeDoc(d);
  const full: KnowledgeDoc = { ...saved, body: d.body };
  set({ docs: [full, ...state.docs.filter((x) => x.id !== saved.id)], error: null });
  return full;
}

export async function deleteDoc(id: string) {
  await sync().deleteKnowledgeDoc(id);
  set({ docs: state.docs.filter((d) => d.id !== id) });
}
