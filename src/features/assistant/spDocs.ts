/**
 * Documentación del Asistente en SharePoint, con la sesión de la persona (la usa la extensión «Marea · Lista», en
 * segundo plano o en una pestaña de SharePoint):
 *
 * - `resolve`: de la dirección de una carpeta (también un enlace de «compartir» `/:f:/s/…`) a su sitio y su ruta.
 * - `search`: el buscador de SharePoint (`/_api/search/query`, KQL) en todo el sitio o en una carpeta: título, enlace y el
 *   trozo con las palabras resaltadas. Lee Word, PDF, PowerPoint, Excel… sin descargar nada.
 * - `list`: los archivos más recientes de la carpeta.
 * - `upload`: sube un archivo a la carpeta (sin sustituir uno que ya exista).
 * - `folder`: un nivel de una carpeta (subcarpetas y archivos con tamaño y fecha) para navegarla en la pantalla SharePoint.
 * - `file`: un PDF o una imagen (hasta 10 MB) en base64, para verlo dentro de Marea.
 * - `people`: buscar personas del directorio (nombre, email y cargo), para invitarlas a reuniones.
 * - `text`: el texto de un archivo (Word, PowerPoint, Excel, texto…) para Claude, si la persona lo permite.
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
    const siteTitle = web.Title || decodeURIComponent(String(web.Url).split('/').filter(Boolean).pop() || '');
    return { siteUrl: web.Url, siteTitle, folder, folderName, folderUrl: u.origin + encodeURI(folder) };
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
    // Primero con todas las palabras; si salen pocos, se completan con los que tienen alguna (SharePoint los ordena por
    // relevancia, así que los que tienen más palabras salen antes).
    let hits = await run(String(args.query || ''));
    let loose = false;
    const want = Math.min(Number(args.limit) || 8, 30);
    if (hits.length < Math.min(3, want) && args.orQuery && args.orQuery !== args.query) {
      const seen: Record<string, boolean> = {};
      for (const h of hits) seen[h.url] = true;
      const more = (await run(String(args.orQuery))).filter((h: Any) => !seen[h.url]);
      loose = !hits.length && more.length > 0;
      hits = hits.concat(more).slice(0, want);
    }
    return { hits, loose };
  }

  /** Archivos de la carpeta y sus subcarpetas (hasta 4 niveles y 400 archivos; sin «Forms» ni las ocultas). */
  const walk = async (site: string, root: string) => {
    const origin = new URL(site).origin;
    const files: Any[] = [];
    let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
    while (queue.length && files.length < 400) {
      const next: { path: string; depth: number }[] = [];
      for (const f of queue) {
        const fs = await get(folderApi(site, f.path, '/Files?$select=Name,ServerRelativeUrl,TimeLastModified,Length'));
        for (const x of fs.value || []) {
          files.push({ name: x.Name, path: x.ServerRelativeUrl, url: origin + encodeURI(x.ServerRelativeUrl), modified: x.TimeLastModified, size: Number(x.Length) || 0,
            folder: f.path === root ? '' : f.path.slice(root.length + 1) });
        }
        if (f.depth >= 4) continue;
        const ds = await get(folderApi(site, f.path, '/Folders?$select=Name,ServerRelativeUrl'));
        for (const d of ds.value || []) if (d.Name !== 'Forms' && d.Name.charAt(0) !== '_') next.push({ path: d.ServerRelativeUrl, depth: f.depth + 1 });
      }
      queue = next;
    }
    return files.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  };

  if (op === 'list') {
    const site = String(args.siteUrl);
    sp(site);
    const files = await walk(site, String(args.folder));
    return { total: files.length, files: files.slice(0, 40).map((f) => ({ name: f.name, url: f.url, modified: f.modified, size: f.size, folder: f.folder })) };
  }

  // Archivos de Office (.docx, .pptx, .xlsx): son un ZIP con XML dentro. Se leen sin librerías.
  const unzip = async (zip: Uint8Array, want: (name: string) => boolean): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let e = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return out;
    let p = v.getUint32(e + 16, true);
    const count = v.getUint16(e + 10, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count && p + 46 <= zip.length; n++) {
      const method = v.getUint16(p + 10, true);
      const size = v.getUint32(p + 20, true);
      const nl = v.getUint16(p + 28, true);
      const el = v.getUint16(p + 30, true);
      const cl = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = dec.decode(zip.subarray(p + 46, p + 46 + nl));
      if (want(name)) {
        const begin = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = zip.slice(begin, begin + size);
        out[name] = method === 0 ? dec.decode(data) : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      }
      p += 46 + nl + el + cl;
    }
    return out;
  };
  const ent = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const runs = (xml: string, tag: string) => ent((xml.match(new RegExp('<' + tag + '(?: [^>]*)?>[^<]*</' + tag + '>', 'g')) || []).map((x) => x.replace(/<[^>]+>/g, '')).join(''));
  const num = (name: string) => Number((/(\d+)\.xml$/.exec(name) || [])[1] || 0);
  /** Texto de un archivo según su extensión (null si no se sabe leer). */
  const fileText = async (name: string, r: Response): Promise<string | null> => {
    if (/\.docx$/i.test(name)) {
      const xml = (await unzip(new Uint8Array(await r.arrayBuffer()), (n) => n === 'word/document.xml'))['word/document.xml'] || '';
      const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
      return paras.map((para) => {
        const t = runs(para, 'w:t');
        const h = /<w:pStyle w:val="(?:Heading|Ttulo|Titulo|Título)(\d)"/i.exec(para);
        return h && t.trim() ? '#'.repeat(Number(h[1])) + ' ' + t.trim() : t;
      }).join('\n');
    }
    if (/\.pptx$/i.test(name)) {
      const slides = await unzip(new Uint8Array(await r.arrayBuffer()), (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      return Object.keys(slides).sort((a, b) => num(a) - num(b)).map((k) => {
        const paras = (slides[k].match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((x) => runs(x, 'a:t')).filter((t) => t.trim());
        return '## Diapositiva ' + num(k) + '\n' + paras.join('\n');
      }).join('\n\n');
    }
    if (/\.xlsx$/i.test(name)) {
      const files = await unzip(new Uint8Array(await r.arrayBuffer()), (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
      const shared = (files['xl/sharedStrings.xml'] || '').match(/<si>[\s\S]*?<\/si>/g)?.map((x) => runs(x, 't')) || [];
      const names = ((files['xl/workbook.xml'] || '').match(/<sheet [^>]*name="[^"]*"/g) || []).map((x) => ent((/name="([^"]*)"/.exec(x) || [])[1] || ''));
      return Object.keys(files).filter((k) => k.indexOf('worksheets/') > 0).sort((a, b) => num(a) - num(b)).map((k) => {
        const rows = (files[k].match(/<row[ >][\s\S]*?<\/row>/g) || []).slice(0, 2000).map((row) =>
          (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
            const v = (/<v>([^<]*)<\/v>/.exec(c) || [])[1];
            if (/ t="s"/.test(c)) return shared[Number(v)] || '';
            if (/ t="inlineStr"/.test(c)) return runs(c, 't');
            return v == null ? '' : ent(v);
          }).join(' | ')).filter((t) => t.replace(/[\s|]/g, ''));
        return '## Hoja ' + (names[num(k) - 1] || num(k)) + '\n' + rows.join('\n');
      }).join('\n\n');
    }
    if (/\.(txt|md|markdown|csv|json|xml)$/i.test(name)) return r.text();
    if (/\.html?$/i.test(name)) return ent((await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' '));
    return null;
  };
  const download = (site: string, path: string) => fetch(site + "/_api/web/GetFileByServerRelativePath(decodedurl=@f)/$value?@f='" + q(path) + "'", { credentials: 'include' });

  // Texto de los archivos de la carpeta que se pueden leer sin librerías (Word .docx, texto, Markdown, CSV, HTML), para
  // encontrarlos al momento, sin esperar a que SharePoint los meta en su buscador. `known` (enlace → fecha) evita
  // volver a descargar los que no han cambiado.
  if (op === 'texts') {
    const site = String(args.siteUrl);
    sp(site);
    const known: Any = args.known && typeof args.known === 'object' ? args.known : {};
    const readable = /\.(docx|txt|md|markdown|csv|json|html?|xml)$/i;
    const files = (await walk(site, String(args.folder))).filter((f) => readable.test(f.name) && f.size <= 5 * 1024 * 1024);
    const out: Any[] = [];
    let budget = 3 * 1024 * 1024;
    for (const f of files) {
      if (known[f.url] && known[f.url] === f.modified) { out.push({ url: f.url, unchanged: true }); continue; }
      if (budget <= 0) break;
      try {
        const r = await download(site, f.path);
        if (!r.ok) continue;
        let text = (await fileText(f.name, r)) || '';
        text = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 600000);
        budget -= text.length;
        out.push({ name: f.name, url: f.url, modified: f.modified, folder: f.folder, text });
      } catch {
        // Un archivo que no se puede leer no para el resto.
      }
    }
    return { files: out, total: files.length };
  }

  // El texto de un archivo (Word, PowerPoint, Excel, texto, CSV, HTML; hasta 15 MB) para que Claude lo lea, si la persona
  // lo ha permitido. Nada se guarda: va a Marea, que lo pasa al conector.
  if (op === 'text') {
    const site = String(args.siteUrl);
    sp(site);
    const path = String(args.path);
    const name = path.split('/').pop() || '';
    if (/\.(pdf|doc|ppt|xls)$/i.test(name)) throw new Error('«' + name + '» no se puede leer como texto (solo Word .docx, PowerPoint .pptx, Excel .xlsx, texto, CSV y HTML). Ábrelo en SharePoint.');
    const r = await download(site, path);
    if (r.status === 401 || r.status === 403) throw fail(r.status, 'SharePoint no deja abrirlo (' + r.status + '): ¿has iniciado sesión en SharePoint en Chrome?');
    if (r.status === 404) throw fail(404, 'No existe «' + name + '» en SharePoint (o no tienes acceso).');
    if (!r.ok) throw fail(r.status, 'SharePoint respondió ' + r.status + ' al abrir el archivo.');
    if (Number(r.headers.get('content-length') || 0) > 15 * 1024 * 1024) throw new Error('«' + name + '» pesa más de 15 MB: ábrelo en SharePoint.');
    const text = await fileText(name, r);
    if (text == null) throw new Error('«' + name + '» no se puede leer como texto (solo Word .docx, PowerPoint .pptx, Excel .xlsx, texto, CSV y HTML). Ábrelo en SharePoint.');
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    return { name, text: clean.slice(0, 400000), truncated: clean.length > 400000 };
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

  // Una carpeta, un nivel, para navegarla desde Marea (pantalla SharePoint): subcarpetas y archivos con tamaño y fecha.
  // Nada del contenido de los documentos.
  if (op === 'folder') {
    const site = String(args.siteUrl);
    sp(site);
    const folder = String(args.folder);
    const origin = new URL(site).origin;
    const link = (p: string) => origin + p.split('/').map(encodeURIComponent).join('/');
    const sel = '?$select=Name,ServerRelativeUrl,ItemCount,TimeLastModified,Length&$top=2001';
    const [ds, fs] = await Promise.all([get(folderApi(site, folder, '/Folders' + sel)), get(folderApi(site, folder, '/Files' + sel))]);
    const entries = [
      ...(ds.value || []).filter((d: Any) => d.Name !== 'Forms' && d.Name.charAt(0) !== '_').map((d: Any) => ({
        kind: 'folder', name: d.Name, path: d.ServerRelativeUrl, url: link(d.ServerRelativeUrl), size: d.ItemCount ?? null, modified: d.TimeLastModified ?? null })),
      // ?web=1: los documentos de Office se abren en el navegador.
      ...(fs.value || []).map((f: Any) => ({
        kind: 'file', name: f.Name, path: f.ServerRelativeUrl, url: link(f.ServerRelativeUrl) + '?web=1', size: Number(f.Length) || 0, modified: f.TimeLastModified ?? null })),
    ];
    return { path: folder, site: new URL(site).pathname.replace(/\/+$/, ''), url: link(folder), entries: entries.slice(0, 2000), truncated: entries.length > 2000 };
  }

  // Un PDF o una imagen (hasta 10 MB) para verlo dentro de Marea, en base64. Solo esos tipos.
  if (op === 'file') {
    const site = String(args.siteUrl);
    sp(site);
    const path = String(args.path);
    if (!/\.(pdf|png|jpe?g|gif|webp)$/i.test(path)) throw new Error('Solo se pueden ver aquí PDF e imágenes.');
    const r = await fetch(site + "/_api/web/GetFileByServerRelativePath(decodedurl=@f)/$value?@f='" + q(path) + "'", { credentials: 'include' });
    if (r.status === 401 || r.status === 403) throw fail(r.status, 'SharePoint no deja abrirlo (' + r.status + '): ¿has iniciado sesión en SharePoint en Chrome?');
    if (!r.ok) throw fail(r.status, 'SharePoint respondió ' + r.status + ' al abrir el archivo.');
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > 10 * 1024 * 1024) throw new Error('El archivo pesa más de 10 MB: ábrelo en SharePoint.');
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { base64: btoa(bin), size: buf.byteLength };
  }

  // Personas del directorio de esa organización, como el buscador de «Compartir» de SharePoint (para invitar a reuniones).
  // Solo lo que se escribe, hasta 10; nombre, email y cargo. Si el selector no deja (p. ej. a invitados), se prueba con el
  // buscador de personas de SharePoint.
  if (op === 'people') {
    const site = String(args.siteUrl);
    sp(site);
    const query = String(args.query || '').trim().slice(0, 80);
    if (query.length < 2) return { people: [] };
    const out: Any[] = [];
    const seen: Record<string, boolean> = {};
    const push = (name: string, email: string, title: string) => {
      const e = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || seen[e]) return;
      seen[e] = true;
      out.push({ name: String(name || e), email: e, title: String(title || '') });
    };
    let pickerError: Any = null;
    try {
      const ctx = await fetch(site + '/_api/contextinfo', { method: 'POST', headers: { Accept: J }, credentials: 'include' });
      if (!ctx.ok) throw fail(ctx.status, 'SharePoint respondió ' + ctx.status + '.');
      const digest = (await ctx.json()).FormDigestValue;
      const r = await fetch(site + '/_api/SP.UI.ApplicationPages.ClientPeoplePickerWebServiceInterface.clientPeoplePickerSearchUser', {
        method: 'POST', credentials: 'include',
        headers: { Accept: J, 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest },
        body: JSON.stringify({ queryParams: { __metadata: { type: 'SP.UI.ApplicationPages.ClientPeoplePickerQueryParameters' },
          QueryString: query, MaximumEntitySuggestions: 10, AllowEmailAddresses: false, AllowOnlyEmailAddresses: false,
          AllowMultipleEntities: true, PrincipalType: 1, PrincipalSource: 15, SharePointGroupID: 0 } }),
      });
      if (!r.ok) throw fail(r.status, 'SharePoint respondió ' + r.status + '.');
      const body: Any = await r.json();
      const raw = body.value ?? (body.d && body.d.ClientPeoplePickerSearchUser) ?? '[]';
      for (const p of (typeof raw === 'string' ? JSON.parse(raw) : raw) || []) {
        const d = p.EntityData || {};
        push(p.DisplayText, d.Email || (String(p.Key || '').split('|').pop() || ''), d.Title || d.Department || '');
      }
    } catch (e) {
      pickerError = e;
    }
    if (!out.length) {
      try {
        const words = query.replace(/["'*]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w + '*').join(' ');
        const r = await get(site + "/_api/search/query?querytext='" + q(words) + "'&sourceid='b09a7990-05ea-4af9-81ef-edfab16c4e31'"
          + "&selectproperties='PreferredName,WorkEmail,JobTitle'&rowlimit=10");
        const rows: Any[] = (((r.PrimaryQueryResult || {}).RelevantResults || {}).Table || {}).Rows || [];
        for (const row of rows) {
          const c: Any = {};
          for (const cell of row.Cells || []) c[cell.Key] = cell.Value;
          push(c.PreferredName, c.WorkEmail, c.JobTitle);
        }
      } catch (e) {
        if (pickerError) throw pickerError;
        throw e;
      }
    }
    return { people: out.slice(0, 10) };
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
