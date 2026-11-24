import { spWork } from './spWork';

/**
 * Marcador «Marea · Lista»: se arrastra a la barra de marcadores y se pulsa estando en la lista de SharePoint. Sin
 * Power Automate ni permisos de Microsoft: usa la sesión que ya tiene abierta la persona en SharePoint (la API REST
 * de su propia web, sin CORS) y se comunica con Marea por `postMessage`:
 *
 * 1. Abre Marea (`#/lista`) en otra pestaña y le dice «hola» hasta que contesta (Marea tiene que tener la sesión iniciada).
 * 2. Se queda conectado mientras la pestaña de SharePoint siga abierta: cada 4 s vuelve a decir «hola» y Marea responde
 *    con los cambios pendientes (estados y campos cambiados en el gestor) y si quiere la lista entera.
 * 3. Si hay cambios, los aplica en la lista (MERGE); después la vuelve a leer y se la manda a Marea con el resultado.
 *
 * El trabajo en SharePoint es `spWork` (el mismo de la extensión), que se le pasa como argumento. `bridge` y `spWork` se
 * convierten en texto con `toString()`, así que no pueden usar NADA de fuera de su función.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aquí todo viene de SharePoint sin tipos
type Any = any;

function bridge(app: string, work: typeof spWork) {
  // Si ya estaba conectado (se ha vuelto a pulsar), se para el anterior.
  const w: Any = window;
  if (typeof w.__mareaListaStop === 'function') w.__mareaListaStop();
  const old = document.getElementById('marea-lista-box');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'marea-lista-box';
  box.title = 'Marea · Lista: deja esta pestaña abierta y los cambios de Marea se aplican solos. Clic para encoger.';
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:10px 14px;border-radius:10px;cursor:pointer;'
    + 'background:#1B2B4B;color:#fff;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)';
  let small = false;
  let lastText = '';
  const paint = () => { box.textContent = small ? 'Marea ●' : 'Marea · ' + lastText; };
  box.onclick = () => { small = !small; paint(); };
  document.body.appendChild(box);
  /** `end`: se ha parado del todo (el aviso se quita a los 15 s). */
  const say = (t: string, end?: boolean) => {
    lastText = t;
    if (end) small = false;
    paint();
    if (end) setTimeout(() => box.remove(), 15000);
  };
  const clock = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  const m = /^(.*?)\/Lists\/([^/]+)/i.exec(decodeURIComponent(location.pathname));
  if (!m) { say('Abre la lista en SharePoint (una dirección con /Lists/…) y vuelve a pulsar el marcador.', true); return; }
  const listUrl = location.origin + m[1] + '/Lists/' + m[2];

  const win = window.open(app + '/#/lista', 'marea-lista');
  if (!win) { say('El navegador ha bloqueado la ventana de Marea: permite las ventanas emergentes de esta página y vuelve a pulsar.', true); return; }
  say('Abriendo Marea… (inicia sesión si te lo pide)');

  /*
   * Se queda conectado mientras esta pestaña siga abierta: cada pocos segundos le pregunta a Marea si hay cambios. Marea
   * contesta con los pendientes y si quiere la lista entera (cada 2 minutos); si hay cambios, se aplican y se manda la
   * lista con el resultado.
   */
  let connected = false;
  let busy = false;
  let stopped = false;
  const hello = () => {
    if (win.closed) { stop(); say('La pestaña de Marea se ha cerrado. Vuelve a pulsar el marcador para seguir sincronizando.', true); return; }
    try { win.postMessage({ type: 'marea-lista:hello' }, app); } catch { /* aún cargando */ }
  };
  let timer = setInterval(hello, 700);
  const giveUp = setTimeout(() => {
    if (connected) return;
    stop();
    say('Marea no ha contestado. ¿Has iniciado sesión? Vuelve a pulsar el marcador.', true);
  }, 120000);
  function stop() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(giveUp);
    window.removeEventListener('message', onMessage);
    if (w.__mareaListaStop === stop) w.__mareaListaStop = null;
  }
  w.__mareaListaStop = stop;

  async function onMessage(e: MessageEvent) {
    const data: Any = e.data;
    if (stopped || busy || e.origin !== app || e.source !== win || !data || data.type !== 'marea-lista:ready') return;
    if (!connected) {
      connected = true;
      clearTimeout(giveUp);
      clearInterval(timer);
      timer = setInterval(hello, 4000);
    }
    const changes: Any[] = Array.isArray(data.changes) ? data.changes : [];
    if (!changes.length && !data.wantList) return;
    busy = true;
    try {
      const { list, results } = await work(listUrl, changes, true, say);
      win!.postMessage({ type: 'marea-lista:data', list, results }, app);
      const bad = results.filter((r: Any) => !r.ok).length;
      say('Conectado · ' + list.items.length + ' elementos · ' + clock()
        + (results.length ? ' · ' + (results.length - bad) + ' cambios aplicados' + (bad ? ', ' + bad + ' con error' : '') : '')
        + '. Deja esta pestaña abierta.');
    } catch (err: Any) {
      const message = String(err?.message ?? err);
      win!.postMessage({ type: 'marea-lista:error', message }, app);
      say('Error (se reintenta solo): ' + message);
    } finally {
      busy = false;
    }
  }
  window.addEventListener('message', onMessage);
}

/** Código que ejecuta el marcador para esta instancia de Marea (`app` = su dirección, p. ej. https://….vercel.app). */
export const bookmarkletCode = (app: string) => `(${bridge.toString()})(${JSON.stringify(app)}, ${spWork.toString()});`;

/** El `href` del marcador (`javascript:…`). React no deja ponerlo en JSX: se pone con `setAttribute`. */
export const bookmarkletHref = (app: string) => `javascript:${encodeURIComponent(`${bookmarkletCode(app)}void 0`)}`;
