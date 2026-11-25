/**
 * Claude lee las carpetas de SharePoint guardadas en Marea (migración 018). Funciones puras que usa la pestaña de Marea
 * para decidir si una petición de Claude se puede hacer: **solo dentro de una carpeta guardada** (personal o de un proyecto
 * que la persona ve), nunca en el resto del SharePoint.
 */

export type SpOp = 'folder' | 'search' | 'read';

export interface SpRequest {
  id: string;
  op: SpOp;
  /** `folderUrl`: enlace de la carpeta guardada; `path`: ruta en SharePoint (o enlace) de una subcarpeta o un archivo; `query`: búsqueda. */
  args: { folderUrl?: string; path?: string; query?: string };
}

/** Carpeta guardada ya resuelta por la extensión: su sitio y su ruta en SharePoint («/sites/X/Shared Documents/Guías»). */
export interface SpRoot {
  url: string;
  name: string;
  siteUrl: string;
  folder: string;
}

/** Ruta en SharePoint a partir de una ruta o un enlace (https://x.sharepoint.com/sites/A/Doc/a.docx?web=1). Null si no vale. */
export function serverPath(raw: string): { host: string | null; path: string } | null {
  const text = raw.trim();
  if (!text) return null;
  let host: string | null = null;
  let path = text;
  if (/^https:\/\//i.test(text)) {
    let u: URL;
    try { u = new URL(text); } catch { return null; }
    if (!/^[a-z0-9-]+\.sharepoint\.com$/i.test(u.hostname)) return null;
    host = u.hostname.toLowerCase();
    path = u.searchParams.get('id') ?? u.pathname;
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  path = path.replace(/\/+$/, '');
  if (!path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.')) return null;
  return { host, path };
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const inside = (root: string, path: string) => {
  const r = root.toLowerCase().replace(/\/+$/, '');
  const p = path.toLowerCase();
  return p === r || p.startsWith(`${r}/`);
};

/** La carpeta guardada que contiene esa ruta (la más concreta), o null. */
export function rootFor(roots: SpRoot[], raw: string): { root: SpRoot; path: string } | null {
  const sp = serverPath(raw);
  if (!sp) return null;
  const matches = roots.filter((r) => (!sp.host || hostOf(r.siteUrl) === sp.host) && inside(r.folder, sp.path))
    .sort((a, b) => b.folder.length - a.folder.length);
  return matches[0] ? { root: matches[0], path: sp.path } : null;
}

/** Mismo enlace de carpeta guardada (sin fijarse en la barra final ni en mayúsculas del dominio). */
export const sameFolderUrl = (a: string, b: string) => {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').replace(/^https:\/\/[^/]+/i, (m) => m.toLowerCase());
  return norm(a) === norm(b);
};

/** Lo que se le devuelve a Claude de una carpeta: lo justo (nombre, tipo, ruta, enlace, tamaño y fecha). */
export interface SpEntry { kind: 'folder' | 'file'; name: string; path: string; url: string; size: number | null; modified: string | null }
export const MAX_ENTRIES = 300;

/** Texto de un archivo para Claude, por partes de `PART` caracteres (las respuestas muy largas no le caben). */
export const PART = 60_000;
export function textPart(text: string, part = 1): { text: string; part: number; parts: number } {
  const parts = Math.max(1, Math.ceil(text.length / PART));
  const n = Math.min(Math.max(1, Math.floor(part) || 1), parts);
  return { text: text.slice((n - 1) * PART, n * PART), part: n, parts };
}
