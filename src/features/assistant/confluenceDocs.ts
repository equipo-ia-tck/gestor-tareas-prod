import { useSyncExternalStore } from 'react';
import { sync } from '../../data/sync';
import type { ConfluencePage } from '../../domain/confluence';
export { confluenceChunks, isConfluenceChunk } from '../../domain/confluence';

/**
 * Documentación de Confluence para el Asistente: las páginas del export mensual que sube una administradora a Supabase
 * (tabla `docs`, migración 014; la misma que usa el conector MCP). La leen las cuentas activas por RLS. Se carga al abrir
 * el Asistente y se guarda en memoria de la sesión; solo se vuelve a pedir si `docs_info` dice que ha cambiado.
 */

export interface ConfluenceState { pages: ConfluencePage[]; updatedAt: string | null; loading: boolean; error: string | null; loaded: boolean }

let state: ConfluenceState = { pages: [], updatedAt: null, loading: false, error: null, loaded: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<ConfluenceState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useConfluenceDocs = () => useSyncExternalStore(subscribe, () => state);

const PAGE = 500;

/** Pide la documentación si aún no está o si ha cambiado desde la última vez. */
export async function loadConfluenceDocs(): Promise<void> {
  if (state.loading) return;
  set({ loading: true, error: null });
  try {
    const db = sync().supabase;
    const info = await db.rpc('docs_info');
    if (info.error) throw new Error(info.error.message);
    const { count, updatedAt } = info.data as { count: number; updatedAt: string | null };
    if (state.loaded && updatedAt === state.updatedAt) { set({ loading: false }); return; }
    const pages: ConfluencePage[] = [];
    for (let from = 0; from < count; from += PAGE) {
      const r = await db.from('docs').select('id,space,title,path,url,body').order('id').range(from, from + PAGE - 1);
      if (r.error) throw new Error(r.error.message);
      pages.push(...(r.data as ConfluencePage[]));
      if (r.data.length < PAGE) break;
    }
    set({ pages, updatedAt, loading: false, loaded: true });
  } catch (e) {
    const m = (e as Error).message;
    // Sin la migración 014 no hay documentación: no es un error para quien usa el Asistente.
    set({ loading: false, loaded: true, error: /docs_info|function.*does not exist|relation.*docs|404/i.test(m) ? null : m });
  }
}
