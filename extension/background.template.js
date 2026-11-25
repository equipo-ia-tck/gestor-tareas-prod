// Marea · Lista (segundo plano). Generado por scripts/build-extension.mjs: el trabajo en SharePoint (`spWork`) sale de
// src/features/mslist/spWork.ts, el mismo que usa el marcador.
const spWork = /*SPWORK*/;
const spDocs = /*SPDOCS*/;

/** Lo mismo, para ejecutar dentro de una pestaña de SharePoint (tiene que llevar `spWork` dentro: se pasa como texto). */
async function pageJob(listUrl, changes, wantList) {
  const work = /*SPWORK*/;
  try {
    return { ok: true, value: await work(listUrl, changes, wantList) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), status: (e && e.status) || 0 };
  }
}

/** Lo mismo para la documentación (buscar, carpeta, subir) dentro de una pestaña de SharePoint. */
async function pageDocs(op, args) {
  const docs = /*SPDOCS*/;
  try {
    return { ok: true, value: await docs(op, args) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), status: (e && e.status) || 0 };
  }
}

const LIST = /^https:\/\/[a-z0-9-]+\.sharepoint\.com\/.+\/Lists\/[^/?#]+$/i;
const SP = /^https:\/\/[a-z0-9-]+\.sharepoint\.com(\/|$)/i;
const DOC_OPS = ['resolve', 'search', 'list', 'texts', 'upload', 'folder', 'file', 'text', 'people'];

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Solo del puente de Marea (content.js, dentro de una pestaña).
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab) return false;
  const fail = (e) => reply({ error: String((e && e.message) || e) });
  if (msg.type === 'marea-ext:sync') { sync(msg).then(reply, fail); return true; }
  if (msg.type === 'marea-ext:docs') { docs(msg).then((value) => reply({ value }), fail); return true; }
  return false;
});

/** Documentación del Asistente: en segundo plano y, si SharePoint no deja, en una pestaña de SharePoint. */
async function docs(msg) {
  const op = String(msg.op || '');
  const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
  const target = String(args.url || args.siteUrl || '');
  if (!DOC_OPS.includes(op) || !SP.test(target)) throw new Error('Petición de documentación no válida.');
  try {
    return await spDocs(op, args);
  } catch (e) {
    if (e && e.status && e.status !== 401 && e.status !== 403) throw e;
    if (!(e && e.status) && !(e instanceof TypeError)) throw e;
    const r = await runInTab(target, pageDocs, [op, args]);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }
}

let queue = Promise.resolve();
/** De una en una: dos pestañas de Marea no escriben a la vez. */
function sync(msg) {
  const run = queue.then(() => doSync(msg));
  queue = run.catch(() => {});
  return run;
}

async function doSync(msg) {
  const listUrl = String(msg.listUrl || '');
  if (!LIST.test(listUrl)) throw new Error('Esa dirección no es de una lista de SharePoint.');
  const changes = Array.isArray(msg.changes) ? msg.changes.slice(0, 500) : [];
  const wantList = msg.wantList === true;
  try {
    return { via: 'background', ...(await spWork(listUrl, changes, wantList)) };
  } catch (e) {
    // Un error de SharePoint que no es de sesión (404, 500…) también lo daría en una pestaña.
    if (e && e.status && e.status !== 401 && e.status !== 403) throw e;
    // Sin sesión en segundo plano o SharePoint no deja: se hace en una pestaña de SharePoint, como el marcador.
    return { via: 'tab', ...(await inTab(listUrl, changes, wantList)) };
  }
}

async function inTab(listUrl, changes, wantList) {
  const r = await runInTab(listUrl, pageJob, [listUrl, changes, wantList]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Ejecuta `func` en una pestaña de ese SharePoint (la que haya abierta o una fijada nueva en segundo plano). */
async function runInTab(url, func, args) {
  const origin = new URL(url).origin;
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  let tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    await loaded(tab.id);
  }
  let out;
  try {
    [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  } catch {
    throw new Error('No se puede usar SharePoint: ábrelo en Chrome e inicia sesión (la pestaña fijada de SharePoint).');
  }
  const r = out && out.result;
  if (!r) throw new Error('SharePoint no ha contestado.');
  return r;
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, 60000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
