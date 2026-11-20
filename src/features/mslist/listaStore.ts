import { useSyncExternalStore } from 'react';
import type { MsListConfig } from '../../domain/msList';
import {
  addPending, remainingPending, withPending, type MsListChange, type MsListItem, type MsListResult, type MsListSnapshot,
} from '../../domain/msListParse';

/**
 * La lista de SharePoint en este navegador (prueba sin servidor): la última lectura del marcador, los cambios hechos en
 * el gestor que aún no se han aplicado en la lista y la configuración de estados. Todo en localStorage.
 */

const SNAPSHOT_KEY = 'gestor-tareas:lista-snapshot';
const PENDING_KEY = 'gestor-tareas:lista-pending';
const CONFIG_KEY = 'gestor-tareas:lista-config';
const ERRORS_KEY = 'gestor-tareas:lista-errors';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento: solo en memoria */ }
}

export interface ListaState {
  snapshot: MsListSnapshot | null;
  pending: MsListChange[];
  /** Errores de la última aplicación, por `changeKey`. */
  errors: Record<string, string>;
}

let state: ListaState = { snapshot: read(SNAPSHOT_KEY, null), pending: read(PENDING_KEY, []), errors: read(ERRORS_KEY, {}) };
const listeners = new Set<() => void>();
function set(next: Partial<ListaState>) {
  state = { ...state, ...next };
  if ('snapshot' in next) write(SNAPSHOT_KEY, state.snapshot);
  if ('pending' in next) write(PENDING_KEY, state.pending);
  if ('errors' in next) write(ERRORS_KEY, state.errors);
  for (const l of listeners) l();
}

export const getListaState = () => state;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useLista = () => useSyncExternalStore(subscribe, getListaState);

/** Los elementos tal como quedarán en la lista (con los cambios pendientes puestos). */
export const currentItems = (s: ListaState = state): MsListItem[] => withPending(s.snapshot?.items ?? [], s.pending);

/** Apunta un cambio para la próxima vez que se pulse el marcador. */
export function queueChange(id: string, field: string, value: string) {
  const items = state.snapshot?.items ?? [];
  const errors = { ...state.errors };
  delete errors[`${id}|${field}`];
  set({ pending: addPending(state.pending, { id, field, value, at: new Date().toISOString() }, items), errors });
}

export function dropChange(key: string) {
  const errors = { ...state.errors };
  delete errors[key];
  set({ pending: state.pending.filter((c) => `${c.id}|${c.field}` !== key), errors });
}

/** Lo que manda el marcador: la lista recién leída y cómo ha ido cada cambio. */
export function receiveSnapshot(snapshot: MsListSnapshot, results: MsListResult[]) {
  const errors: Record<string, string> = {};
  for (const r of results) if (!r.ok) errors[r.key] = r.error ?? 'No se ha podido aplicar.';
  set({ snapshot, pending: remainingPending(state.pending, snapshot.items, results), errors });
}

export function forgetLista() {
  set({ snapshot: null, pending: [], errors: {} });
}

export function loadListaConfig(): MsListConfig {
  const parsed = read<Partial<MsListConfig>>(CONFIG_KEY, {});
  return { statusColumn: parsed.statusColumn ?? null, map: parsed.map ?? {} };
}

export function saveListaConfig(config: MsListConfig) {
  write(CONFIG_KEY, config);
  for (const l of listeners) l();
}
