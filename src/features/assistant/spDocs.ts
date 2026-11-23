/**
 * Documentación del Asistente en SharePoint, con la sesión de la persona (la usa la extensión «Marea · Lista», en
 * segundo plano o en una pestaña de SharePoint):
 *
 * - `resolve`: de la dirección de una carpeta (también un enlace de «compartir» `/:f:/s/…`) a su sitio y su ruta.
 * - `search`: el buscador de SharePoint (`/_api/search/query`, KQL) en todo el sitio o en una carpeta: título, enlace y el
 *   trozo con las palabras resaltadas. Lee Word, PDF, PowerPoint, Excel… sin descargar nada.
 * - `list`: los archivos más recientes de la carpeta.
 * - `upload`: sube un archivo a la carpeta (sin sustituir uno que ya exista).
 *
 * Se convierte en texto con `toString()` (como `spWork`): no puede usar nada de fuera de la función ni este archivo
 * puede tener imports.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aquí todo viene de SharePoint sin tipos
type Any = any;

export async function spDocs(op: string, args: Any): Promise<Any> {
  const J = 'application/json;odata=nometadata';
  const fail = (status: number, text: string) => { const e: Any = new Error(text); e.status = status; return e; };
  const get = async (url: string): Promise<Any> => {
    const r = await fetch(url, { headers: { Accept: J }, credentials: 'include' });
    if (r.status === 401 || r.status === 403) throw fail(r.status, 'SharePoint no deja leerlo (' + r.status + '): ¿has iniciado sesión en SharePoint en Chrome?');
    if (!r.ok) throw fail(r.status, 'SharePoint respondió ' + r.status + '.');
    const type = r.headers.get('content-type') || '';
    if (type && type.indexOf('json') < 0) throw fail(401, 'SharePoint pide iniciar sesión: ábrelo en Chrome y entra.');
    return r.json();
  };
  const sp = (u: string) => {
    const x = new URL(u);
    if (x.protocol !== 'https:' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(x.hostname)) throw new Error('Esa dirección no es de SharePoint.');
    return x;
  };
  const q = (s: string) => encodeURIComponent(String(s).replace(/'/g, "''"));
  const folderApi = (site: string, folder: string, rest: string) =>
    site + '/_api/web/GetFolderByServerRelativePath(decodedurl=@p)' + rest + (rest.indexOf('?') >= 0 ? '&' : '?') + "@p='" + q(folder) + "'";

  if (op === 'resolve') {
    const u = sp(String(args.url));
    let path = u.searchParams.get('id') || u.searchParams.get('RootFolder') || '';
    if (!path && /^\/:[a-z]:\//i.test(u.pathname)) {
      // Enlace de «compartir»: SharePoint dice a qué apunta (API de OneDrive del propio SharePoint).
      const b64 = btoa(unescape(encodeURIComponent(String(args.url)))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
      try {
        const item = await get(u.origin + '/_api/v2.0/shares/u!' + b64 + '/driveItem?$select=name,webUrl');
        path = decodeURIComponent(new URL(item.webUrl).pathname);
      } catch {
        throw new Error('No he podido abrir ese enlace de «compartir». Abre la carpeta en SharePoint y copia la dirección del navegador.');
      }
    }
    if (!path) path = decodeURIComponent(u.pathname).replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '');
    const m = /^(\/(?:sites|teams)\/[^/]+)/i.exec(path);
    const web = await get(u.origin + (m ? m[1] : '') + '/_api/web?$select=Title,Url');
    let folder = path;
    let folderName = '';
    try {
      const f = await get(folderApi(web.Url, path, '?$select=Name,ServerRelativeUrl'));
      folder = f.ServerRelativeUrl;
      folderName = f.Name;
    } catch {
      throw new Error('Esa dirección no es de una carpeta de SharePoint (o no tienes acceso).');
    }
    return { siteUrl: web.Url, siteTitle: web.Title, folder, folderName, folderUrl: u.origin + encodeURI(folder) };
  }

  if (op === 'search') {
    const site = String(args.siteUrl);
    sp(site);
    const scope = String(args.scope || site);
    const run = async (kql: string) => {
      const query = (kql + ' path:"' + scope + '"').trim();
      const url = site + "/_api/search/query?querytext='" + q(query) + "'"
        + "&selectproperties='" + 'Title,Path,HitHighlightedSummary,Author,LastModifiedTime,FileType,FileExtension,IsDocument' + "'"
        + '&rowlimit=' + Math.min(Number(args.limit) || 8, 30) + '&trimduplicates=true&summarylength=320';
      const r = await get(url);
      const rows: Any[] = (((r.PrimaryQueryResult || {}).RelevantResults || {}).Table || {}).Rows || [];
      return rows.map((row: Any) => {
        const c: Any = {};
        for (const cell of row.Cells || []) c[cell.Key] = cell.Value;
        return { title: c.Title || '', url: c.Path || '', summary: c.HitHighlightedSummary || '', author: c.Author || '', modified: c.LastModifiedTime || '', type: c.FileType || c.FileExtension || '' };
      }).filter((h: Any) => h.url);
    };
    let hits = await run(String(args.query || ''));
    let loose = false;
    if (!hits.length && args.orQuery && args.orQuery !== args.query) { hits = await run(String(args.orQuery)); loose = true; }
    return { hits, loose };
  }

  if (op === 'list') {
    const site = String(args.siteUrl);
    sp(site);
    const r = await get(folderApi(site, String(args.folder), '/Files?$select=Name,ServerRelativeUrl,TimeLastModified,Length&$orderby=TimeLastModified desc&$top=40'));
    const origin = new URL(site).origin;
    return { files: (r.value || []).map((f: Any) => ({ name: f.Name, url: origin + encodeURI(f.ServerRelativeUrl), modified: f.TimeLastModified, size: Number(f.Length) || 0 })) };
  }

  if (op === 'upload') {
    const site = String(args.siteUrl);
    sp(site);
    const name = String(args.name || '').replace(/[\\/:*?"<>|#%]/g, '_').trim();
    if (!name) throw new Error('Falta el nombre del archivo.');
    const ctx = await fetch(site + '/_api/contextinfo', { method: 'POST', headers: { Accept: J }, credentials: 'include' });
    if (!ctx.ok) throw fail(ctx.status, 'SharePoint no deja subir archivos (' + ctx.status + ').');
    const digest = (await ctx.json()).FormDigestValue;
    const bin = Uint8Array.from(atob(String(args.base64)), (ch) => ch.charCodeAt(0));
    const r = await fetch(folderApi(site, String(args.folder), "/Files/AddUsingPath(decodedurl=@n,overwrite=false)?@n='" + q(name) + "'"), {
      method: 'POST', credentials: 'include', headers: { Accept: J, 'X-RequestDigest': digest }, body: bin,
    });
    if (!r.ok) {
      const body: Any = await r.json().catch(() => null);
      const msg = (body && body['odata.error'] && body['odata.error'].message && body['odata.error'].message.value) || '';
      throw fail(r.status, /exist/i.test(msg) || r.status === 409 ? 'Ya hay un archivo con el nombre «' + name + '» en la carpeta.' : 'SharePoint no ha dejado subir «' + name + '» (' + r.status + (msg ? ': ' + msg : '') + ').');
    }
    const f = await r.json();
    return { name: f.Name, url: new URL(site).origin + encodeURI(f.ServerRelativeUrl) };
  }

  throw new Error('Operación desconocida.');
}

/** Consulta para el buscador de SharePoint a partir de una pregunta: sin palabras vacías; todas (AND) y, si no hay nada, alguna (OR). */
export function kqlFrom(question: string, stop: (word: string) => boolean): { query: string; orQuery: string } | null {
  const words = (question.match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []).filter((w) => w.length > 1 && !stop(w)).slice(0, 12);
  if (!words.length) return null;
  const quoted = words.map((w) => (/[^\p{L}\p{N}]/u.test(w) ? `"${w}"` : w));
  return { query: quoted.join(' '), orQuery: quoted.join(' OR ') };
}

/** El resumen de SharePoint (`<c0>palabra</c0>`, `<ddd/>`) en texto y rangos resaltados. */
export function summaryMarks(summary: string): { text: string; marks: [number, number][] } {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => entities[e]);
  let text = '';
  const marks: [number, number][] = [];
  let at = 0;
  for (const m of summary.matchAll(/<c\d+>(.*?)<\/c\d+>|<ddd\/>|<[^>]+>/g)) {
    text += decode(summary.slice(at, m.index));
    if (m[1] !== undefined) { const word = decode(m[1]); marks.push([text.length, text.length + word.length]); text += word; }
    else if (m[0] === '<ddd/>') text += '…';
    at = m.index! + m[0].length;
  }
  text += decode(summary.slice(at));
  return { text, marks };
}
