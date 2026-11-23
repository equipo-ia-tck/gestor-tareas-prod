// Marea · Lista (segundo plano). Generado por scripts/build-extension.mjs: el trabajo en SharePoint (`spWork`) sale de
// src/features/mslist/spWork.ts, el mismo que usa el marcador.
const spWork = /*SPWORK*/;

/** Lo mismo, para ejecutar dentro de una pestaña de SharePoint (tiene que llevar `spWork` dentro: se pasa como texto). */
async function pageJob(listUrl, changes, wantList) {
  const work = /*SPWORK*/;
  try {
    return { ok: true, value: await work(listUrl, changes, wantList) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), status: (e && e.status) || 0 };
  }
}

const LIST = /^https:\/\/[a-z0-9-]+\.sharepoint\.com\/.+\/Lists\/[^/?#]+$/i;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Solo del puente de Marea (content.js, dentro de una pestaña).
  if (!msg || msg.type !== 'marea-ext:sync' || sender.id !== chrome.runtime.id || !sender.tab) return false;
  sync(msg).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});

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
  const origin = new URL(listUrl).origin;
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  let tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: listUrl, active: false, pinned: true });
    await loaded(tab.id);
  }
  let out;
  try {
    [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageJob, args: [listUrl, changes, wantList] });
  } catch {
    throw new Error('No se puede usar SharePoint: abre la lista en Chrome e inicia sesión (la pestaña fijada de SharePoint).');
  }
  const r = out && out.result;
  if (!r) throw new Error('SharePoint no ha contestado.');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, 60000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
