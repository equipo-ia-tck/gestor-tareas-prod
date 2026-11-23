import { useSyncExternalStore } from 'react';
import type { SharePointSnapshot } from '../../domain/sharepoint';

/**
 * Lo que manda el marcador, **solo en memoria** de esta pestaña (a propósito: son datos de CaixaBank). No se guarda en
 * Supabase, IndexedDB ni localStorage; al recargar o cerrar la pestaña desaparece.
 */
let snapshot: SharePointSnapshot | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setSnapshot(s: SharePointSnapshot | null) { snapshot = s; error = null; emit(); }
export function setSnapshotError(message: string | null) { error = message; emit(); }

let state: { snapshot: SharePointSnapshot | null; error: string | null } = { snapshot, error };
const read = () => {
  if (state.snapshot !== snapshot || state.error !== error) state = { snapshot, error };
  return state;
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSharePointSnapshot = () => useSyncExternalStore(subscribe, read);
