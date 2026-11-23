/**
 * Marcador «Marea · Carpeta»: se arrastra a la barra de marcadores y se pulsa estando en una carpeta del SharePoint
 * (el de CaixaBank, con la cuenta de proveedor externo). Sin permisos de Microsoft ni flujos: usa la sesión que ya tiene
 * abierta la persona (la API REST de su propio sitio, sin CORS), **solo lee** y se lo pasa a Marea por `postMessage`:
 *
 * 1. Lee la carpeta abierta: sus subcarpetas y archivos (nombre, enlace, tamaño y fecha). Nada de su contenido.
 * 2. Abre Marea (`#/sharepoint`) y le dice «hola» hasta que contesta (con la sesión iniciada).
 * 3. Le manda la lista. Marea la enseña y no la guarda: al cerrar la pestaña desaparece.
 * 4. Se queda de puente mientras su pestaña siga abierta: Marea le pide otra carpeta del mismo sitio (navegar sin salir de
 *    Marea) o un PDF o una imagen de hasta 20 MB para verlo (solo en la memoria de la pestaña de Marea).
 *
 * `bridge` se convierte en texto con `toString()`: no puede usar nada de fuera de la función.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lo que llega de SharePoint no tiene tipos
type Any = any;

function bridge(app: string) {
  const J = 'application/json;odata=nometadata';
  const MAX = 2000;
  const old = document.getElementById('marea-sp-box');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'marea-sp-box';
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;border-radius:10px;'
    + 'background:#1B2B4B;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)';
  document.body.appendChild(box);
  const say = (t: string, end?: boolean) => {
    box.textContent = 'Marea · ' + t;
    if (end) setTimeout(() => box.remove(), 10000);
  };

  // Carpeta abierta: el parámetro `id` (o `RootFolder`) de la vista de la biblioteca o, si no, la ruta de la página.
  const here = new URL(location.href);
  let path = here.searchParams.get('id') || here.searchParams.get('RootFolder') || '';
  if (!path) {
    let p = here.pathname;
    try { p = decodeURIComponent(p); } catch { /* se queda como está */ }
    path = p.replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '');
  }
  path = path.replace(/\/+$/, '');
  if (!/^\/(sites|teams)\/[^/]+\/.+/i.test(path)) {
    say('Abre una carpeta de una biblioteca de documentos de SharePoint y vuelve a pulsar el marcador.', true);
    return;
  }
  const site = (/^\/(sites|teams)\/[^/]+/i.exec(path) as RegExpExecArray)[0];
  const web = location.origin + site;
  // Cada tramo codificado: un nombre con # o ? no rompe el enlace.
  const link = (serverRelative: string) => location.origin + serverRelative.split('/').map(encodeURIComponent).join('/');
  // Solo se lee dentro del sitio de la carpeta en la que se pulsó el marcador.
  const inSite = (p: unknown): p is string => typeof p === 'string' && p.indexOf(site + '/') === 0 && p.indexOf('..') < 0 && p.length < 1000;
  const at = (p: string) => "@u='" + encodeURIComponent(p.replace(/'/g, "''")) + "'";

  async function read(folder: string) {
    const sel = '$select=Name,ServerRelativeUrl,ItemCount,TimeLastModified,Length';
    const q = (part: string) => web + '/_api/web/GetFolderByServerRelativePath(decodedurl=@u)/' + part + '?' + sel + '&$top=' + (MAX + 1) + '&' + at(folder);
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { Accept: J }, credentials: 'include' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No se encuentra la carpeta.' : 'SharePoint respondió ' + r.status + '.');
      return (await r.json()).value as Any[];
    };
    const [folders, files] = await Promise.all([get(q('Folders')), get(q('Files'))]);
    const entries = [
      ...folders.filter((f) => f.Name !== 'Forms').map((f) => ({ kind: 'folder', name: f.Name, path: f.ServerRelativeUrl, url: link(f.ServerRelativeUrl), size: f.ItemCount ?? null, modified: f.TimeLastModified ?? null })),
      // ?web=1: los documentos de Office se abren en el navegador.
      ...files.map((f) => ({ kind: 'file', name: f.Name, path: f.ServerRelativeUrl, url: link(f.ServerRelativeUrl) + '?web=1', size: Number(f.Length) || 0, modified: f.TimeLastModified ?? null })),
    ];
    return { type: 'marea-sp:folder', path: folder, site, url: link(folder), entries: entries.slice(0, MAX), truncated: entries.length > MAX };
  }

  // Vista previa: solo PDF e imágenes, hasta 20 MB. Se manda el archivo a la pestaña de Marea (no se guarda en ningún sitio).
  const PREVIEW = /\.(pdf|png|jpe?g|gif|webp)$/i;
  const MAX_FILE = 20 * 1024 * 1024;
  async function file(p: string) {
    if (!PREVIEW.test(p)) throw new Error('Solo se pueden ver aquí PDF e imágenes.');
    const r = await fetch(web + '/_api/web/GetFileByServerRelativePath(decodedurl=@u)/$value?' + at(p), { credentials: 'include' });
    if (!r.ok) throw new Error('SharePoint respondió ' + r.status + ' al abrir el archivo.');
    const size = Number(r.headers.get('content-length') || 0);
    if (size > MAX_FILE) throw new Error('El archivo pesa más de 20 MB: ábrelo en SharePoint.');
    const buffer = await r.arrayBuffer();
    if (buffer.byteLength > MAX_FILE) throw new Error('El archivo pesa más de 20 MB: ábrelo en SharePoint.');
    return buffer;
  }

  const win = window.open(app + '/#/sharepoint', 'marea-sharepoint');
  if (!win) { say('El navegador ha bloqueado la ventana de Marea: permite las ventanas emergentes de esta página y vuelve a pulsar.', true); return; }
  say('Abriendo Marea… (inicia sesión si te lo pide)');
  let started = false;
  const hello = setInterval(() => { try { win.postMessage({ type: 'marea-sp:hello' }, app); } catch { /* aún cargando */ } }, 700);
  const giveUp = setTimeout(() => {
    clearInterval(hello);
    if (!started) { window.removeEventListener('message', onMessage); say('Marea no ha contestado. ¿Has iniciado sesión? Vuelve a pulsar el marcador.', true); }
  }, 120000);

  // Después del primer envío, esta pestaña hace de puente: Marea le pide otras carpetas del sitio o un archivo para verlo.
  async function onMessage(e: MessageEvent) {
    const data: Any = e.data;
    if (e.origin !== app || e.source !== win || !data) return;
    if (data.type === 'marea-sp:ready' && !started) {
      started = true;
      clearInterval(hello);
      clearTimeout(giveUp);
      try {
        say('Leyendo la carpeta…');
        const snapshot = await read(path);
        win!.postMessage(snapshot, app);
        say('Conectado con Marea. Deja esta pestaña abierta para moverte por las carpetas desde Marea.');
      } catch (err: Any) {
        win!.postMessage({ type: 'marea-sp:error', message: String(err?.message ?? err) }, app);
        say('Error: ' + String(err?.message ?? err), true);
      }
      return;
    }
    if (!started) return;
    if (data.type === 'marea-sp:list') {
      try {
        if (!inSite(data.path)) throw new Error('Esa carpeta no es de este sitio de SharePoint.');
        win!.postMessage({ ...(await read(data.path)), request: data.request }, app);
      } catch (err: Any) {
        win!.postMessage({ type: 'marea-sp:error', message: String(err?.message ?? err), request: data.request }, app);
      }
    } else if (data.type === 'marea-sp:file') {
      try {
        if (!inSite(data.path)) throw new Error('Ese archivo no es de este sitio de SharePoint.');
        const buffer = await file(data.path);
        win!.postMessage({ type: 'marea-sp:filedata', request: data.request, path: data.path, buffer }, app, [buffer]);
      } catch (err: Any) {
        win!.postMessage({ type: 'marea-sp:error', message: String(err?.message ?? err), request: data.request }, app);
      }
    }
  }
  window.addEventListener('message', onMessage);
}

/** Código que ejecuta el marcador para esta instancia de Marea (`app` = su dirección). */
export const bookmarkletCode = (app: string) => `(${bridge.toString()})(${JSON.stringify(app)});`;

/** El `href` del marcador (`javascript:…`). React no deja ponerlo en JSX: se pone con `setAttribute`. */
export const bookmarkletHref = (app: string) => `javascript:${encodeURIComponent(`${bookmarkletCode(app)}void 0`)}`;
