import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { directorySites } from '../../domain/sharepoint';
import { extDocs } from '../mslist/extension';
import { extensionReady } from '../sharepoint/sharepointStore';

/**
 * Personas del directorio de La Caixa para invitar a reuniones: la extensión de Chrome busca lo que se escribe con la
 * sesión de SharePoint de la persona (como «Compartir» en SharePoint), en el sitio de sus carpetas guardadas. Solo se busca
 * lo escrito y se queda en memoria: Marea no guarda ningún listado.
 */
export interface DirectoryPerson { name: string; email: string; title: string }

export async function searchDirectory(sites: string[], query: string): Promise<DirectoryPerson[]> {
  const found = await Promise.allSettled(sites.map((siteUrl) => extDocs<{ people: DirectoryPerson[] }>('people', { siteUrl, query }, 20_000)));
  const seen = new Set<string>();
  const out: DirectoryPerson[] = [];
  for (const r of found) {
    if (r.status !== 'fulfilled') continue;
    for (const p of r.value.people ?? []) {
      const email = String(p.email ?? '').toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ name: String(p.name || email), email, title: String(p.title ?? '') });
    }
  }
  if (!out.length && found.length && found.every((r) => r.status === 'rejected')) throw (found[0] as PromiseRejectedResult).reason;
  return out.slice(0, 8);
}

/** Busca en el directorio lo que se escribe (desde 3 letras, con una pausa de 350 ms). Sin extensión o sin carpetas, nada. */
export function useDirectory(query: string) {
  const { projects, settings } = useApp();
  const sites = useMemo(() => directorySites([...settings.sharepoint_folders, ...projects.flatMap((p) => p.folders ?? [])]),
    [projects, settings.sharepoint_folders]);
  const available = sites.length > 0 && extensionReady();
  const [state, setState] = useState<{ q: string; people: DirectoryPerson[]; loading: boolean; error: string | null }>({ q: '', people: [], loading: false, error: null });
  const q = query.trim();
  useEffect(() => {
    if (!available || q.length < 3 || q.includes('@')) { setState({ q, people: [], loading: false, error: null }); return; }
    let alive = true;
    setState((s) => ({ ...s, q, loading: true, error: null }));
    const timer = setTimeout(() => {
      searchDirectory(sites, q).then(
        (people) => { if (alive) setState({ q, people, loading: false, error: null }); },
        (e: Error) => { if (alive) setState({ q, people: [], loading: false, error: e.message }); },
      );
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, available, sites]);
  return { available, ...state, people: state.q === q ? state.people : [] };
}
