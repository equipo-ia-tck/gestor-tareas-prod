import { useSyncExternalStore } from 'react';
import { terms } from '../../domain/knowledge';
import { MAX_ENTRIES, rootFor, sameFolderUrl, type SpEntry, type SpRequest, type SpRoot } from '../../domain/spClaude';
import type { SharePointFolder } from '../../domain/sharepoint';
import { kqlFrom } from '../assistant/spDocs';

/**
 * Claude lee las carpetas de SharePoint guardadas en Marea (migración 018). Claude pide al conector MCP, el conector deja
 * la petición en Supabase y esta pestaña la hace con la extensión de Chrome (la sesión de SharePoint de la persona).
 *
 * Reglas: solo si la persona lo ha activado en la pantalla SharePoint, solo dentro de las carpetas guardadas (personales
 * o de un proyecto que ve) y solo leer: ver una carpeta, buscar en ella y leer el texto de un archivo. Nada se guarda aquí.
 */

type Ext = <T>(op: 'resolve' | 'folder' | 'search' | 'text', args: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** Carpetas ya resueltas (sitio y ruta), por enlace, mientras dure la pestaña. */
const resolved = new Map<string, Promise<SpRoot>>();
function rootOf(f: SharePointFolder, ext: Ext): Promise<SpRoot> {
  let p = resolved.get(f.url);
  if (!p) {
    p = ext<{ siteUrl: string; folder: string }>('resolve', { url: f.url }, 60_000)
      .then((w) => ({ url: f.url, name: f.name, siteUrl: w.siteUrl, folder: w.folder }));
    p.catch(() => resolved.delete(f.url));
    resolved.set(f.url, p);
  }
  return p;
}

async function allRoots(folders: SharePointFolder[], ext: Ext): Promise<SpRoot[]> {
  const out = await Promise.allSettled(folders.map((f) => rootOf(f, ext)));
  return out.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

const NOT_SAVED = 'Esa carpeta no está guardada en Marea. Claude solo puede leer las carpetas guardadas en la pantalla SharePoint (o en un proyecto).';
const OUTSIDE = 'Eso no está dentro de ninguna carpeta guardada en Marea: Claude solo puede leer dentro de ellas.';
const link = (siteUrl: string, path: string) => new URL(siteUrl).origin + path.split('/').map(encodeURIComponent).join('/');
const strip = (html: string) => html.replace(/<ddd\/>/g, '…').replace(/<\/?c\d>/g, '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Hace una petición de Claude y devuelve lo que se le contesta (o lanza el error que verá Claude). */
export async function handleSpRequest(req: SpRequest, folders: SharePointFolder[], ext: Ext): Promise<unknown> {
  if (!folders.length) throw new Error('No hay carpetas de SharePoint guardadas en Marea.');
  const saved = req.args.folderUrl ? folders.find((f) => sameFolderUrl(f.url, req.args.folderUrl!)) : null;
  if (req.args.folderUrl && !saved) throw new Error(NOT_SAVED);

  if (req.op === 'folder') {
    let root: SpRoot;
    let path: string;
    if (saved) {
      root = await rootOf(saved, ext);
      path = root.folder;
      if (req.args.path) {
        const m = rootFor([root], req.args.path);
        if (!m) throw new Error(`Esa ruta no está dentro de la carpeta «${root.name}».`);
        path = m.path;
      }
    } else {
      const m = req.args.path ? rootFor(await allRoots(folders, ext), req.args.path) : null;
      if (!m) throw new Error(req.args.path ? OUTSIDE : 'Falta decir qué carpeta.');
      ({ root, path } = m);
    }
    const r = await ext<{ path: string; url: string; entries: SpEntry[]; truncated: boolean }>('folder', { siteUrl: root.siteUrl, folder: path }, 90_000);
    const entries = r.entries.slice(0, MAX_ENTRIES).map((e) => ({ kind: e.kind, name: e.name, path: e.path, url: e.url, size: e.size, modified: e.modified }));
    return { folder: root.name, folderUrl: root.url, path: r.path, url: r.url, entries, truncated: r.truncated || r.entries.length > MAX_ENTRIES };
  }

  if (req.op === 'search') {
    const query = (req.args.query ?? '').trim();
    if (!query) throw new Error('Falta qué buscar.');
    const kql = kqlFrom(query, (w) => !terms(w).length) ?? { query, orQuery: query };
    const roots = saved ? [await rootOf(saved, ext)] : await allRoots(folders.slice(0, 10), ext);
    const results = [];
    const errors: string[] = [];
    for (const root of roots) {
      try {
        const scope = link(root.siteUrl, root.folder);
        const r = await ext<{ hits: { title: string; url: string; summary: string; author: string; modified: string; type: string }[] }>(
          'search', { siteUrl: root.siteUrl, scope, query: kql.query, orQuery: kql.orQuery, limit: 8 }, 60_000);
        const hits = r.hits.filter((h) => rootFor([root], h.url)).map((h) => ({ ...h, summary: strip(h.summary), path: rootFor([root], h.url)!.path }));
        results.push({ folder: root.name, folderUrl: root.url, hits });
      } catch (e) {
        errors.push(`«${root.name}»: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!results.length && errors.length) throw new Error(errors.join(' · '));
    return { results, errors };
  }

  if (req.op === 'read') {
    if (!req.args.path) throw new Error('Falta qué archivo leer.');
    const roots = saved ? [await rootOf(saved, ext)] : await allRoots(folders, ext);
    const m = rootFor(roots, req.args.path);
    if (!m) throw new Error(OUTSIDE);
    const r = await ext<{ name: string; text: string; truncated: boolean }>('text', { siteUrl: m.root.siteUrl, path: m.path }, 120_000);
    return { folder: m.root.name, name: r.name, path: m.path, url: `${link(m.root.siteUrl, m.path)}?web=1`, text: r.text, truncated: r.truncated };
  }

  throw new Error('Petición no válida.');
}

// ───────────── Lo último que ha pedido Claude (solo en memoria, para enseñarlo en la pantalla) ─────────────

export interface SpLogEntry { at: number; op: SpRequest['op']; what: string; error: string | null }
let log: SpLogEntry[] = [];
const listeners = new Set<() => void>();
export function logSpRequest(e: SpLogEntry) {
  log = [e, ...log].slice(0, 8);
  for (const l of listeners) l();
}
export const useSpLog = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => log);

/** Qué ha pedido, en pocas palabras (sin el contenido). */
export function describeRequest(req: SpRequest, folders: SharePointFolder[]): string {
  const folder = req.args.folderUrl ? folders.find((f) => sameFolderUrl(f.url, req.args.folderUrl!))?.name : null;
  const file = req.args.path ? decodeURIComponent(req.args.path.split('?')[0].split('/').pop() ?? '') : '';
  if (req.op === 'search') return `Buscar «${req.args.query ?? ''}»${folder ? ` en ${folder}` : ''}`;
  if (req.op === 'read') return `Leer ${file || 'un archivo'}`;
  return `Ver ${req.args.path ? file : folder ?? 'una carpeta'}`;
}
