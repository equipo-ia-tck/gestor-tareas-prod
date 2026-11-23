import { useCallback, useEffect, useState } from 'react';
import { sync } from '../../data/sync';
import { parseSyncedRoots, type SyncedRoot } from '../../domain/sharepointSync';

export interface SyncedSharePoint { roots: SyncedRoot[]; fileAt: string | null; uploadedAt: string }

/** Las carpetas que ha subido el Mac (null si aún no hay). Cada persona solo ve lo suyo (RLS de la migración 005). */
export async function loadSyncedSharePoint(): Promise<SyncedSharePoint | null> {
  const { data, error } = await sync().supabase.from('connector_uploads')
    .select('data, file_at, uploaded_at').eq('kind', 'sharepoint').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { data: unknown; file_at: string | null; uploaded_at: string };
  return { roots: parseSyncedRoots(row.data), fileAt: row.file_at, uploadedAt: row.uploaded_at };
}

/** Lo sincronizado, cargado una vez por pestaña (en memoria) y con «Actualizar». */
let cache: SyncedSharePoint | null | undefined;
/** Lo sincronizado ya cargado en esta pestaña (para abrir una carpeta guardada sin esperar). */
export const syncedNow = () => cache ?? null;
/** Lo sincronizado; si aún no se ha cargado en esta pestaña, lo carga (sin errores: null si no hay o falla). */
export async function ensureSynced(): Promise<SyncedSharePoint | null> {
  if (cache === undefined) { try { cache = await loadSyncedSharePoint(); } catch { return null; } }
  return cache ?? null;
}
export function useSyncedSharePoint() {
  const [value, setValue] = useState<SyncedSharePoint | null | undefined>(cache);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      cache = await loadSyncedSharePoint();
      setValue(cache);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (cache === undefined) void reload(); }, [reload]);
  return { synced: value, error, loading, reload };
}
