// Marea · Lista: puente entre la página de Marea y la extensión. Solo atiende mensajes de la propia página de Marea
// (mismo origen) y solo pide a la extensión sincronizar una lista de SharePoint.
(() => {
  const announce = () => {
    try {
      window.postMessage({ type: 'marea-ext:hello', version: chrome.runtime.getManifest().version }, location.origin);
    } catch { /* la extensión se ha recargado: hay que recargar Marea */ }
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    const d = e.data;
    if (d.type === 'marea-ext:ping') { announce(); return; }
    if (d.type !== 'marea-ext:sync' || typeof d.id !== 'string') return;
    const answer = (res) => window.postMessage({ type: 'marea-ext:result', id: d.id, ...res }, location.origin);
    try {
      chrome.runtime.sendMessage({ type: 'marea-ext:sync', listUrl: d.listUrl, changes: d.changes, wantList: d.wantList }, (res) => {
        const err = chrome.runtime.lastError;
        answer(err ? { error: err.message } : res || { error: 'La extensión no ha contestado.' });
      });
    } catch {
      answer({ error: 'La extensión se ha actualizado: recarga Marea.' });
    }
  });
  announce();
})();
