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
 * `bridge` se convierte en texto con `toString()`, así que no puede usar NADA de fuera de la función (ni imports ni
 * constantes del módulo).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aquí todo viene de SharePoint sin tipos
type Any = any;

function bridge(app: string) {
  const J = 'application/json;odata=nometadata';
  const TYPES = ['Text', 'Note', 'Choice', 'MultiChoice', 'Number', 'Currency', 'DateTime', 'Boolean', 'User', 'UserMulti', 'Lookup', 'LookupMulti', 'URL'];
  const EDIT = ['Text', 'Note', 'Choice', 'MultiChoice', 'Number', 'Currency', 'DateTime', 'Boolean'];
  const SKIP = /^(_|ContentType|Attachments|Edit$|LinkTitle|DocIcon|ItemChildCount|FolderChildCount|AppAuthor|AppEditor|ComplianceAssetId)/;

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
  const web = location.origin + m[1];
  const listPath = m[1] + '/Lists/' + m[2];
  const api = (s: string) => web + '/_api/web/GetList(@u)' + s + (s.indexOf('?') >= 0 ? '&' : '?')
    + "@u='" + encodeURIComponent(listPath.replace(/'/g, "''")) + "'";
  const get = async (url: string): Promise<Any> => {
    const r = await fetch(url, { headers: { Accept: J }, credentials: 'include' });
    if (!r.ok) throw new Error('SharePoint respondió ' + r.status + ' al leer la lista.');
    return r.json();
  };
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const text = (v: Any, f: Any): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map((x) => text(x, f)).filter(Boolean).join(', ');
    if (typeof v === 'object') return String(v.Title ?? v.Description ?? v.Url ?? '');
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (f.TypeAsString === 'DateTime') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? String(v) : f.DisplayFormat === 1 ? day(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : day(d);
    }
    if (f.TypeAsString === 'Note' && /</.test(String(v))) {
      return (new DOMParser().parseFromString(String(v), 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return String(v);
  };

  async function columns(): Promise<Any[]> {
    const all: Any[] = (await get(api('/fields?$filter=Hidden eq false'))).value;
    const seen: Record<string, boolean> = {};
    return all.filter((f) => {
      const ok = TYPES.indexOf(f.TypeAsString) >= 0 && !SKIP.test(f.InternalName) && (f.InternalName === 'Title' || !f.ReadOnlyField) && !seen[f.Title];
      if (ok) seen[f.Title] = true;
      return ok;
    });
  }

  async function apply(changes: Any[], fields: Any[]) {
    const results: Any[] = [];
    if (!changes.length) return results;
    const ctx = await fetch(web + '/_api/contextinfo', { method: 'POST', headers: { Accept: J }, credentials: 'include' });
    if (!ctx.ok) throw new Error('SharePoint no deja escribir (' + ctx.status + ').');
    const digest = (await ctx.json()).FormDigestValue;
    for (const c of changes) {
      const key = c.id + '|' + c.field;
      const f = c.field === 'Título' ? fields.find((x) => x.InternalName === 'Title') : fields.find((x) => x.Title === c.field);
      if (!f || EDIT.indexOf(f.TypeAsString) < 0 || !/^\d+$/.test(String(c.id))) {
        results.push({ key, ok: false, error: 'La columna «' + c.field + '» no se puede cambiar desde Marea.' });
        continue;
      }
      const v = String(c.value ?? '').trim();
      let val: Any = v === '' ? null : v;
      if (val !== null) {
        if (f.TypeAsString === 'Number' || f.TypeAsString === 'Currency') val = Number(v.replace(',', '.'));
        else if (f.TypeAsString === 'Boolean') val = /^(s[ií]|true|1|yes)$/i.test(v);
        else if (f.TypeAsString === 'MultiChoice') val = v.split(/\s*,\s*/).filter(Boolean);
        else if (f.TypeAsString === 'DateTime') val = new Date(/\d:\d/.test(v) ? v.replace(' ', 'T') : v + 'T00:00:00').toISOString();
      }
      try {
        const r = await fetch(api('/items(' + Number(c.id) + ')'), {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: J, 'Content-Type': J, 'X-RequestDigest': digest, 'IF-MATCH': '*', 'X-HTTP-Method': 'MERGE' },
          body: JSON.stringify({ [f.InternalName]: val }),
        });
        if (r.ok) results.push({ key, ok: true });
        else {
          const body: Any = await r.json().catch(() => null);
          results.push({ key, ok: false, error: 'SharePoint ' + r.status + (body?.['odata.error']?.message?.value ? ': ' + body['odata.error'].message.value : '') });
        }
      } catch (e: Any) {
        results.push({ key, ok: false, error: String(e?.message ?? e) });
      }
    }
    return results;
  }

  async function read(fields: Any[]) {
    const info = await get(api('?$select=Title'));
    const select = ['Id', 'Title', 'Modified'];
    const expand: string[] = [];
    for (const f of fields) {
      if (f.InternalName === 'Title') continue;
      if (/^(User|Lookup)/.test(f.TypeAsString)) { select.push(f.InternalName + '/Title'); expand.push(f.InternalName); }
      else select.push(f.InternalName);
    }
    let url: string | undefined = api('/items?$top=1000&$select=' + select.join(',') + (expand.length ? '&$expand=' + expand.join(',') : ''));
    const rows: Any[] = [];
    while (url && rows.length < 10000) {
      const r: Any = await get(url);
      for (const it of r.value) rows.push(it);
      url = r['odata.nextLink'];
      say('Leyendo la lista… ' + rows.length + ' elementos');
    }
    const base = location.origin + listPath;
    return {
      title: info.Title,
      url: base,
      at: new Date().toISOString(),
      fields: fields.map((f) => ({
        name: f.InternalName,
        label: f.InternalName === 'Title' ? 'Título' : f.Title,
        type: f.TypeAsString,
        choices: f.Choices ?? [],
        editable: EDIT.indexOf(f.TypeAsString) >= 0,
        format: f.TypeAsString === 'DateTime' ? (f.DisplayFormat === 1 ? 'datetime' : 'date') : undefined,
      })),
      items: rows.map((it) => {
        const values: Record<string, string> = {};
        for (const f of fields) {
          if (f.InternalName === 'Title') continue;
          const t = text(it[f.InternalName], f);
          if (t) values[f.Title] = t;
        }
        return { id: String(it.Id), title: String(it.Title ?? ''), fields: values, url: base + '/DispForm.aspx?ID=' + it.Id, modified: it.Modified ?? null };
      }),
    };
  }

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
  let fields: Any[] | null = null;
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
      // Las columnas, una vez (y otra vez si la lectura falla, por si se han cambiado en SharePoint).
      if (!fields) { say('Leyendo la lista…'); fields = await columns(); }
      if (changes.length) say('Aplicando ' + changes.length + (changes.length === 1 ? ' cambio…' : ' cambios…'));
      const results = await apply(changes, fields);
      const list = await read(fields);
      win!.postMessage({ type: 'marea-lista:data', list, results }, app);
      const bad = results.filter((r: Any) => !r.ok).length;
      say('Conectado · ' + list.items.length + ' elementos · ' + clock()
        + (results.length ? ' · ' + (results.length - bad) + ' cambios aplicados' + (bad ? ', ' + bad + ' con error' : '') : '')
        + '. Deja esta pestaña abierta.');
    } catch (err: Any) {
      fields = null;
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
export const bookmarkletCode = (app: string) => `(${bridge.toString()})(${JSON.stringify(app)});`;

/** El `href` del marcador (`javascript:…`). React no deja ponerlo en JSX: se pone con `setAttribute`. */
export const bookmarkletHref = (app: string) => `javascript:${encodeURIComponent(`${bookmarkletCode(app)}void 0`)}`;
