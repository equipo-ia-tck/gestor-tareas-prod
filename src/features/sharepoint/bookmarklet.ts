/**
 * Marcador «Marea · Carpeta»: se arrastra a la barra de marcadores y se pulsa estando en una carpeta del SharePoint
 * (el de CaixaBank, con la cuenta de proveedor externo). Sin permisos de Microsoft ni flujos: usa la sesión que ya tiene
 * abierta la persona (la API REST de su propio sitio, sin CORS), **solo lee** y se lo pasa a Marea por `postMessage`:
 *
 * 1. Lee la carpeta abierta: sus subcarpetas y archivos (nombre, enlace, tamaño y fecha). Nada de su contenido.
 * 2. Abre Marea (`#/sharepoint`) y le dice «hola» hasta que contesta (con la sesión iniciada).
 * 3. Le manda la lista. Marea la enseña y no la guarda: al cerrar la pestaña desaparece.
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

  async function read() {
    const sel = '$select=Name,ServerRelativeUrl,ItemCount,TimeLastModified,Length';
    const q = (part: string) => web + "/_api/web/GetFolderByServerRelativePath(decodedurl=@u)/" + part + '?' + sel
      + '&$top=' + (MAX + 1) + "&@u='" + encodeURIComponent(path.replace(/'/g, "''")) + "'";
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { Accept: J }, credentials: 'include' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No se encuentra la carpeta.' : 'SharePoint respondió ' + r.status + '.');
      return (await r.json()).value as Any[];
    };
    const [folders, files] = await Promise.all([get(q('Folders')), get(q('Files'))]);
    const entries = [
      ...folders.filter((f) => f.Name !== 'Forms').map((f) => ({ kind: 'folder', name: f.Name, url: link(f.ServerRelativeUrl), size: f.ItemCount ?? null, modified: f.TimeLastModified ?? null })),
      // ?web=1: los documentos de Office se abren en el navegador.
      ...files.map((f) => ({ kind: 'file', name: f.Name, url: link(f.ServerRelativeUrl) + '?web=1', size: Number(f.Length) || 0, modified: f.TimeLastModified ?? null })),
    ];
    return { type: 'marea-sp:folder', path, url: link(path), entries: entries.slice(0, MAX), truncated: entries.length > MAX };
  }

  const win = window.open(app + '/#/sharepoint', 'marea-sharepoint');
  if (!win) { say('El navegador ha bloqueado la ventana de Marea: permite las ventanas emergentes de esta página y vuelve a pulsar.', true); return; }
  say('Abriendo Marea… (inicia sesión si te lo pide)');
  let started = false;
  const hello = setInterval(() => { try { win.postMessage({ type: 'marea-sp:hello' }, app); } catch { /* aún cargando */ } }, 700);
  const giveUp = setTimeout(() => {
    clearInterval(hello);
    window.removeEventListener('message', onMessage);
    if (!started) say('Marea no ha contestado. ¿Has iniciado sesión? Vuelve a pulsar el marcador.', true);
  }, 120000);

  async function onMessage(e: MessageEvent) {
    const data: Any = e.data;
    if (started || e.origin !== app || e.source !== win || !data || data.type !== 'marea-sp:ready') return;
    started = true;
    clearInterval(hello);
    clearTimeout(giveUp);
    window.removeEventListener('message', onMessage);
    try {
      say('Leyendo la carpeta…');
      const snapshot = await read();
      win!.postMessage(snapshot, app);
      say(snapshot.entries.length + ' elementos enviados a Marea (solo se ven, no se guardan).', true);
    } catch (err: Any) {
      const message = String(err?.message ?? err);
      win!.postMessage({ type: 'marea-sp:error', message }, app);
      say('Error: ' + message, true);
    }
  }
  window.addEventListener('message', onMessage);
}

/** Código que ejecuta el marcador para esta instancia de Marea (`app` = su dirección). */
export const bookmarkletCode = (app: string) => `(${bridge.toString()})(${JSON.stringify(app)});`;

/** El `href` del marcador (`javascript:…`). React no deja ponerlo en JSX: se pone con `setAttribute`. */
export const bookmarkletHref = (app: string) => `javascript:${encodeURIComponent(`${bookmarkletCode(app)}void 0`)}`;
