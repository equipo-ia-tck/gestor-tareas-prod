// Sin imports: lo usan la app y el proceso del Mac (scripts/subir-onedrive.ts, Node sin compilar).

/**
 * Carpetas de SharePoint sincronizadas con Power Automate. Un flujo programado lee las carpetas que la persona elige
 * (SharePoint «Obtener archivos (solo propiedades)» con elementos anidados) y escribe OneDrive/Gestor/sharepoint.json; el
 * Mac lo sube recortado con `trimSharePointExport` (solo nombre, ruta, enlace, si es carpeta y fecha: nunca contenido) y
 * Marea lo enseña para navegarlo sin marcador ni pestaña de SharePoint.
 */

/** Un elemento: claves cortas para que la lista pese poco. `p`: ruta dentro del sitio («Documentos compartidos/General/a.pdf»). */
export interface SyncedItem { n: string; p: string; f: boolean; u: string; m: string | null }

/** Una carpeta del flujo con todo lo que tiene dentro. `site`: dirección del sitio; `root`: ruta de la carpeta en el sitio. */
export interface SyncedRoot { site: string; root: string; items: SyncedItem[] }

export const MAX_SYNCED_ITEMS = 20000;

const SP_HOST = /^[a-z0-9-]+\.sharepoint\.com$/i;
function spUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && SP_HOST.test(u.hostname) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pick = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

/** Ruta normalizada: sin barras al principio ni al final y sin «..». */
export function cleanPath(v: unknown): string {
  const s = text(v, 1000).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  return s.split('/').some((x) => x === '..' || x === '.') ? '' : s;
}

export const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Lo que escribe el flujo → lista de carpetas recortada y validada. Acepta el formato de los pasos
 * (`{ carpetas: [{ sitio, carpeta, elementos: [{ nombre, ruta, esCarpeta, enlace, modificado }] }] }`) y también los campos
 * tal como los da SharePoint (`{FilenameWithExtension}`, `{FullPath}`, `{IsFolder}`, `{Link}`, `Modified`). Descarta lo que
 * no tenga enlace https de *.sharepoint.com.
 */
export function trimSharePointExport(json: unknown): SyncedRoot[] {
  const root = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  const list = Array.isArray(json) ? json : Array.isArray(pick(root, 'carpetas', 'folders')) ? pick(root, 'carpetas', 'folders') as unknown[] : [];
  const out: SyncedRoot[] = [];
  let total = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const site = spUrl(pick(c, 'sitio', 'site'));
    if (!site) continue;
    const items: SyncedItem[] = [];
    const seen = new Set<string>();
    const rawItems = pick(c, 'elementos', 'items', 'value');
    for (const r of Array.isArray(rawItems) ? rawItems : []) {
      if (total >= MAX_SYNCED_ITEMS || !r || typeof r !== 'object') break;
      const e = r as Record<string, unknown>;
      const p = cleanPath(pick(e, 'ruta', 'path', '{FullPath}'));
      const u = spUrl(pick(e, 'enlace', 'url', '{Link}'));
      if (!p || !u || seen.has(p)) continue;
      const folder = pick(e, 'esCarpeta', 'isFolder', '{IsFolder}');
      const modified = text(pick(e, 'modificado', 'modified', 'Modified'), 40);
      seen.add(p);
      items.push({
        n: text(pick(e, 'nombre', 'name', '{FilenameWithExtension}', '{Name}'), 300) || nameOf(p),
        p,
        f: folder === true || folder === 'true' || folder === 'True',
        u,
        m: modified && !Number.isNaN(Date.parse(modified)) ? modified : null,
      });
      total++;
    }
    // La carpeta raíz: la que contiene a los elementos menos profundos (o la que diga el flujo si está vacía).
    const depth = (p: string) => p.split('/').length;
    const shallow = items.reduce((a, b) => (depth(b.p) < depth(a.p) ? b : a), items[0]);
    const given = cleanPath(pick(c, 'carpeta', 'folder'));
    out.push({ site: site.replace(/\/+$/, ''), root: shallow ? parentOf(shallow.p) : given, items });
  }
  return out;
}

/** Lo que hay directamente dentro de una carpeta (carpetas primero, cada grupo por nombre). */
export function childrenOf(root: SyncedRoot, path: string): SyncedItem[] {
  return root.items.filter((i) => parentOf(i.p) === path)
    .sort((a, b) => (a.f === b.f ? a.n.localeCompare(b.n, 'es', { numeric: true }) : a.f ? -1 : 1));
}

/** Cuántos elementos tiene directamente una carpeta. */
export const countIn = (root: SyncedRoot, path: string) => root.items.reduce((n, i) => (parentOf(i.p) === path ? n + 1 : n), 0);

/**
 * ¿Está sincronizada esta carpeta? `origin` y `path` como los da `folderLocation` de un enlace guardado
 * («https://x.sharepoint.com», «/sites/X/Documentos compartidos/General»). Devuelve la carpeta sincronizada y su ruta.
 */
export function findSynced(roots: SyncedRoot[], origin: string, path: string): { root: SyncedRoot; path: string } | null {
  for (const r of roots) {
    let site: URL;
    try { site = new URL(r.site); } catch { continue; }
    if (site.origin !== origin) continue;
    const prefix = site.pathname.replace(/\/+$/, '');
    if (!path.startsWith(prefix + '/')) continue;
    const rel = cleanPath(path.slice(prefix.length));
    if (rel === r.root || r.items.some((i) => i.f && i.p === rel)) return { root: r, path: rel };
  }
  return null;
}

/** Busca por nombre en todo lo sincronizado (sin tildes ni mayúsculas), como mucho `limit`. */
export function searchSynced(roots: SyncedRoot[], q: string, limit = 200): { root: SyncedRoot; item: SyncedItem }[] {
  const key = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = key(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: { root: SyncedRoot; item: SyncedItem }[] = [];
  for (const root of roots) {
    for (const item of root.items) {
      const name = key(item.n);
      if (words.every((w) => name.includes(w))) out.push({ root, item });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Lo guardado en Supabase (ya recortado por el Mac), comprobado otra vez al leerlo. */
export function parseSyncedRoots(data: unknown): SyncedRoot[] {
  if (!Array.isArray(data)) return [];
  const out: SyncedRoot[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const site = spUrl(r.site);
    if (!site || !Array.isArray(r.items)) continue;
    const items: SyncedItem[] = [];
    for (const it of r.items.slice(0, MAX_SYNCED_ITEMS)) {
      if (!it || typeof it !== 'object') continue;
      const i = it as Record<string, unknown>;
      const p = cleanPath(i.p);
      const u = spUrl(i.u);
      if (!p || !u) continue;
      const m = text(i.m, 40);
      items.push({ n: text(i.n, 300) || nameOf(p), p, f: i.f === true, u, m: m && !Number.isNaN(Date.parse(m)) ? m : null });
    }
    out.push({ site: site.replace(/\/+$/, ''), root: cleanPath(r.root), items });
  }
  return out;
}
