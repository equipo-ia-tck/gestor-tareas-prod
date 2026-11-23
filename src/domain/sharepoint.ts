/**
 * Carpetas de SharePoint (el de CaixaBank, con la cuenta de proveedor externo). Seguridad:
 * - Marea solo guarda **accesos** (nombre y enlace que pega la persona); nunca documentos ni su contenido.
 * - El contenido de una carpeta llega con un marcador del navegador (la sesión de la persona en SharePoint) y se queda
 *   **solo en la memoria de esa pestaña**: no va a Supabase, ni a IndexedDB, ni a localStorage.
 * - Solo se aceptan direcciones https de `*.sharepoint.com`.
 */

export interface SharePointFolder {
  id: string;
  name: string;
  url: string;
}

/** Elemento de una carpeta tal como llega del marcador. */
export interface SharePointEntry {
  kind: 'folder' | 'file';
  name: string;
  /** Ruta en SharePoint («/sites/X/Shared Documents/Guías/a.pdf»), para navegar o ver el archivo desde Marea. */
  path: string;
  url: string;
  /** Bytes (archivos) o número de elementos (carpetas). */
  size: number | null;
  modified: string | null;
}

export interface SharePointSnapshot {
  /** Ruta de la carpeta en SharePoint («/sites/X/Shared Documents/Guías»). */
  path: string;
  /** Sitio («/sites/X»): desde Marea solo se navega dentro de él. */
  site: string;
  /** Dirección de la carpeta, para abrirla. */
  url: string;
  host: string;
  entries: SharePointEntry[];
  /** Hay más de lo que se ha traído (se corta en `MAX_ENTRIES`). */
  truncated: boolean;
  at: string;
}

export const MAX_ENTRIES = 2000;
const SP_HOST = /^[a-z0-9-]+\.sharepoint\.com$/i;

/** ¿Es una dirección https de SharePoint Online? */
export function isSharePointUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && SP_HOST.test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** ¿El mensaje viene de una página de SharePoint Online? (origen de `postMessage`). */
export const isSharePointOrigin = (origin: string) => /^https:\/\/[a-z0-9-]+\.sharepoint\.com$/i.test(origin);

/**
 * Nombre propuesto para un acceso a partir de su enlace: el último tramo de la carpeta (del parámetro `id` de las vistas
 * de biblioteca o de la ruta). Sin nombre claro, el sitio.
 */
export function folderNameFromUrl(raw: string): string {
  if (!isSharePointUrl(raw)) return '';
  const u = new URL(raw.trim());
  const path = u.searchParams.get('id') ?? u.searchParams.get('RootFolder') ?? safeDecode(u.pathname);
  const parts = path.replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '').split('/').filter(Boolean)
    .filter((p) => !/^:[a-z]:$/i.test(p) && p !== 'r');
  const last = parts[parts.length - 1] ?? '';
  return (last && !/^(sites|teams)$/i.test(last) ? last : parts[1] ?? u.hostname).slice(0, 120);
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Valida lo que manda el marcador (nada de lo que llega se da por bueno). Null si no es válido. */
export function parseSnapshot(data: unknown): SharePointSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const url = str(d.url, 2000);
  if (!isSharePointUrl(url) || !Array.isArray(d.entries)) return null;
  const entries: SharePointEntry[] = [];
  for (const raw of d.entries.slice(0, MAX_ENTRIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const kind = e.kind === 'folder' || e.kind === 'file' ? e.kind : null;
    const name = str(e.name, 300).trim();
    const link = str(e.url, 2000);
    const path = str(e.path, 1000);
    if (!kind || !name || !isSharePointUrl(link) || !path.startsWith('/')) continue;
    const size = typeof e.size === 'number' && Number.isFinite(e.size) && e.size >= 0 ? e.size : null;
    const modified = str(e.modified, 40);
    entries.push({ kind, name, path, url: link, size, modified: modified && !Number.isNaN(Date.parse(modified)) ? modified : null });
  }
  return {
    path: str(d.path, 1000),
    site: str(d.site, 300),
    url,
    host: new URL(url).hostname,
    entries: sortEntries(entries),
    truncated: d.truncated === true || d.entries.length > MAX_ENTRIES,
    at: new Date().toISOString(),
  };
}

/** Carpetas primero y después archivos, cada grupo por nombre. */
export function sortEntries(list: SharePointEntry[]): SharePointEntry[] {
  return [...list].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'es', { numeric: true }) : a.kind === 'folder' ? -1 : 1));
}

/** Tamaño legible de un archivo. */
export function fileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
}

/** Tipo de archivo que se puede ver dentro de Marea (PDF e imágenes); null si se abre en SharePoint. */
export function previewType(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === 'pdf' ? 'application/pdf'
    : ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp' : null;
}

/** Hasta 20 MB se ve dentro de Marea; más, en SharePoint. */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/**
 * Migas de pan de una carpeta: desde la biblioteca («Shared Documents») hasta la carpeta, cada una con su ruta.
 * «/sites/X/Shared Documents/Guías/App» → Shared Documents · Guías · App.
 */
export function breadcrumbs(path: string, site: string): { name: string; path: string }[] {
  if (!site || !path.startsWith(site + '/')) return [];
  const rest = path.slice(site.length + 1).split('/').filter(Boolean);
  return rest.map((name, i) => ({ name, path: `${site}/${rest.slice(0, i + 1).join('/')}` }));
}

/**
 * Dónde está la carpeta de un enlace guardado: el dominio de SharePoint y la ruta («/sites/X/Shared Documents/Guías»),
 * del parámetro `id` (o `RootFolder`) de la vista de biblioteca, de un enlace `/:f:/r/…` o de la propia ruta. Null si no se
 * puede saber (p. ej. un enlace de compartir con código): entonces se abre en SharePoint.
 */
export function folderLocation(raw: string): { origin: string; path: string } | null {
  if (!isSharePointUrl(raw)) return null;
  const u = new URL(raw.trim());
  let path = u.searchParams.get('id') ?? u.searchParams.get('RootFolder') ?? safeDecode(u.pathname);
  path = path.replace(/^\/:[a-z]:\/r(?=\/)/i, '').replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '').replace(/\/+$/, '');
  if (!/^\/(sites|teams)\/[^/]+\/.+/i.test(path) || path.includes('..')) return null;
  return { origin: u.origin, path };
}
