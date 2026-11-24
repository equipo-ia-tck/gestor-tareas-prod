import { useEffect, useState } from 'react';
import { sync } from '../../data/sync';
import type { ConfluencePage } from '../../domain/confluence';

/**
 * Trae la documentación del equipo (tabla `docs` de Supabase, la que sube una administradora desde Confluence) para que el
 * Asistente la busque dentro de Marea, sin salir a Claude. Cada persona la lee con su sesión (RLS: miembros activos). Se
 * carga una vez y se comparte entre pantallas; si falta la migración o no hay sesión, se queda vacía en silencio.
 */

let cache: ConfluencePage[] | null = null;
const listeners = new Set<() => void>();

export async function loadConfluenceDocs(force = false): Promise<void> {
  if (cache && !force) return;
  try {
    const { data, error } = await sync().supabase.from('docs').select('id,space,title,path,url,body');
    if (error) return;
    cache = (data ?? []) as ConfluencePage[];
    for (const l of listeners) l();
  } catch {
    // sin conexión: el Asistente sigue funcionando con lo demás
  }
}

export function useConfluenceDocs(): ConfluencePage[] {
  const [docs, setDocs] = useState<ConfluencePage[]>(cache ?? []);
  useEffect(() => {
    const l = () => setDocs(cache ?? []);
    listeners.add(l);
    void loadConfluenceDocs();
    return () => void listeners.delete(l);
  }, []);
  return docs;
}
