/**
 * Lo que se hace en SharePoint para la Lista: aplicar los cambios pendientes (MERGE) y leer la lista entera, con la API
 * REST y la sesión de la persona. Lo usan el marcador (en la página de la lista) y la extensión «Marea · Lista» (en
 * segundo plano o, si SharePoint no la deja, en una pestaña de la lista).
 *
 * Se convierte en texto con `toString()` (marcador, extensión y `chrome.scripting.executeScript`), así que **no puede usar
 * nada de fuera de la función** ni importar nada, y este archivo no puede tener imports (lo lee Node al empaquetar la
 * extensión).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aquí todo viene de SharePoint sin tipos
type Any = any;

export interface SpWorkResult {
  /** La lista leída (si se ha pedido o se ha aplicado algún cambio). */
  list: Any | null;
  /** Cómo ha ido cada cambio: `{ key: 'id|campo', ok, error? }`. */
  results: Any[];
}

export async function spWork(listUrl: string, changes: Any[], wantList: boolean, progress?: (text: string) => void): Promise<SpWorkResult> {
  const J = 'application/json;odata=nometadata';
  const TYPES = ['Text', 'Note', 'Choice', 'MultiChoice', 'Number', 'Currency', 'DateTime', 'Boolean', 'User', 'UserMulti', 'Lookup', 'LookupMulti', 'URL'];
  const EDIT = ['Text', 'Note', 'Choice', 'MultiChoice', 'Number', 'Currency', 'DateTime', 'Boolean'];
  const SKIP = /^(_|ContentType|Attachments|Edit$|LinkTitle|DocIcon|ItemChildCount|FolderChildCount|AppAuthor|AppEditor|ComplianceAssetId)/;
  const say = (t: string) => { if (progress) progress(t); };

  const u = new URL(listUrl);
  const m = /^(.*?)\/Lists\/([^/]+)/i.exec(decodeURIComponent(u.pathname));
  if (!/\.sharepoint\.com$/i.test(u.hostname) || u.protocol !== 'https:' || !m) throw new Error('Esa dirección no es de una lista de SharePoint.');
  const web = u.origin + m[1];
  const listPath = m[1] + '/Lists/' + m[2];
  const api = (s: string) => web + '/_api/web/GetList(@u)' + s + (s.indexOf('?') >= 0 ? '&' : '?')
    + "@u='" + encodeURIComponent(listPath.replace(/'/g, "''")) + "'";
  const fail = (status: number, what: string) => {
    const e: Any = new Error(status === 401 || status === 403
      ? 'SharePoint no deja ' + what + ' (' + status + '): ¿has iniciado sesión en SharePoint en este navegador?'
      : 'SharePoint respondió ' + status + ' al ' + what + '.');
    e.status = status;
    return e;
  };
  const get = async (url: string): Promise<Any> => {
    const r = await fetch(url, { headers: { Accept: J }, credentials: 'include' });
    if (!r.ok) throw fail(r.status, 'leer la lista');
    const type = r.headers.get('content-type') ?? '';
    // Sin sesión, SharePoint a veces contesta 200 con la página de inicio de sesión.
    if (type && type.indexOf('json') < 0) throw fail(401, 'leer la lista');
    return r.json();
  };
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const plain = (html: string) => (typeof DOMParser !== 'undefined'
    ? new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
    : html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  const text = (v: Any, f: Any): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map((x) => text(x, f)).filter(Boolean).join(', ');
    if (typeof v === 'object') return String(v.Title ?? v.Description ?? v.Url ?? '');
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (f.TypeAsString === 'DateTime') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? String(v) : f.DisplayFormat === 1 ? day(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : day(d);
    }
    if (f.TypeAsString === 'Note' && /</.test(String(v))) return plain(String(v)).replace(/\s+/g, ' ').trim();
    return String(v);
  };

  const all: Any[] = (await get(api('/fields?$filter=Hidden eq false'))).value;
  const seen: Record<string, boolean> = {};
  const fields = all.filter((f) => {
    const ok = TYPES.indexOf(f.TypeAsString) >= 0 && !SKIP.test(f.InternalName) && (f.InternalName === 'Title' || !f.ReadOnlyField) && !seen[f.Title];
    if (ok) seen[f.Title] = true;
    return ok;
  });

  let digestValue = '';
  const getDigest = async () => {
    if (digestValue) return digestValue;
    const ctx = await fetch(web + '/_api/contextinfo', { method: 'POST', headers: { Accept: J }, credentials: 'include' });
    if (!ctx.ok) throw fail(ctx.status, 'escribir en la lista');
    digestValue = (await ctx.json()).FormDigestValue;
    return digestValue;
  };

  /** Texto de Marea → valor de SharePoint según el tipo de columna (`verbose`: formato de las altas). */
  const toSp = (f: Any, raw: Any, verbose: boolean): Any => {
    const v = String(raw ?? '').trim();
    if (v === '') return null;
    const t = f.TypeAsString;
    if (t === 'Number' || t === 'Currency') return Number(v.replace(',', '.'));
    if (t === 'Boolean') return /^(s[ií]|true|1|yes)$/i.test(v);
    if (t === 'MultiChoice') {
      const list = v.split(/\s*,\s*/).filter(Boolean);
      return verbose ? { __metadata: { type: 'Collection(Edm.String)' }, results: list } : list;
    }
    if (t === 'DateTime') return new Date(/\d:\d/.test(v) ? v.replace(' ', 'T') : v + 'T00:00:00').toISOString();
    return v;
  };
  const fieldFor = (label: string) => (label === 'Título' ? fields.find((x) => x.InternalName === 'Title') : fields.find((x) => x.Title === label));
  const spError = async (r: Response) => {
    const body: Any = await r.json().catch(() => null);
    const msg = body?.['odata.error']?.message?.value ?? body?.error?.message?.value;
    return 'SharePoint ' + r.status + (msg ? ': ' + msg : '');
  };

  const results: Any[] = [];
  if (changes.length) {
    say('Aplicando ' + changes.length + (changes.length === 1 ? ' cambio…' : ' cambios…'));
    const digest = await getDigest();
    let entityType = '';
    for (const c of changes) {
      // Alta de un elemento nuevo: { create: true, key: 'new:…', values: { columna: valor } }.
      if (c.create) {
        const key = String(c.key);
        try {
          if (!entityType) entityType = (await get(api('?$select=ListItemEntityTypeFullName'))).ListItemEntityTypeFullName;
          const body: Any = { __metadata: { type: entityType } };
          const skipped: string[] = [];
          for (const label of Object.keys(c.values || {})) {
            const f = fieldFor(label);
            if (!f || EDIT.indexOf(f.TypeAsString) < 0) { skipped.push(label); continue; }
            const val = toSp(f, c.values[label], true);
            if (val !== null) body[f.InternalName] = val;
          }
          if (!body.Title) { results.push({ key, ok: false, error: 'Falta el título.' }); continue; }
          const r = await fetch(api('/items'), {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: J, 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest },
            body: JSON.stringify(body),
          });
          if (!r.ok) { results.push({ key, ok: false, error: await spError(r) }); continue; }
          const made: Any = await r.json();
          results.push({ key, ok: true, id: String(made.Id ?? made.ID ?? ''), ...(skipped.length ? { skipped } : {}) });
        } catch (e: Any) {
          results.push({ key, ok: false, error: String(e?.message ?? e) });
        }
        continue;
      }
      const key = c.id + '|' + c.field;
      const f = fieldFor(c.field);
      if (!f || EDIT.indexOf(f.TypeAsString) < 0 || !/^\d+$/.test(String(c.id))) {
        results.push({ key, ok: false, error: 'La columna «' + c.field + '» no se puede cambiar desde Marea.' });
        continue;
      }
      try {
        const r = await fetch(api('/items(' + Number(c.id) + ')'), {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: J, 'Content-Type': J, 'X-RequestDigest': digest, 'IF-MATCH': '*', 'X-HTTP-Method': 'MERGE' },
          body: JSON.stringify({ [f.InternalName]: toSp(f, c.value, false) }),
        });
        if (r.ok) results.push({ key, ok: true });
        else results.push({ key, ok: false, error: await spError(r) });
      } catch (e: Any) {
        results.push({ key, ok: false, error: String(e?.message ?? e) });
      }
    }
  }
  if (!changes.length && !wantList) return { list: null, results };

  say('Leyendo la lista…');
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
  // Las vistas de la lista (las pestañas de SharePoint): con su propio filtro y orden, se pregunta a SharePoint qué
  // elementos salen y en qué orden (`GetItems` con el CAML de la vista), y se guardan sus columnas y su agrupación.
  const labelOf = (name: string) => (/^(Title|LinkTitle|LinkTitleNoMenu)$/.test(name) ? 'Título'
    : (fields.find((f) => f.InternalName === name) || {}).Title || null);
  const views: Any[] = [];
  try {
    const vs: Any[] = (await get(api('/views?$filter=Hidden eq false&$select=Id,Title,DefaultView,ListViewXml'))).value;
    for (const v of vs.slice(0, 30)) {
      const xml = String(v.ListViewXml || '');
      const viewXml = xml.replace(/<RowLimit[^>]*>[\s\S]*?<\/RowLimit>/gi, '').replace(/<\/View>\s*$/i, '<RowLimit Paged="TRUE">5000</RowLimit></View>');
      const r = await fetch(api('/GetItems?$select=Id'), {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: J, 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': await getDigest() },
        body: JSON.stringify({ query: { __metadata: { type: 'SP.CamlQuery' }, ViewXml: viewXml } }),
      });
      if (!r.ok) continue;
      const ids = ((await r.json()).value || []).map((x: Any) => String(x.Id));
      const fieldsXml = (/<ViewFields>([\s\S]*?)<\/ViewFields>/i.exec(xml) || [])[1] || '';
      const columns: string[] = [];
      const re = /<FieldRef[^>]*Name="([^"]+)"/gi;
      let fm: Any;
      while ((fm = re.exec(fieldsXml))) { const l = labelOf(fm[1]); if (l && columns.indexOf(l) < 0) columns.push(l); }
      const group = /<GroupBy[^>]*>\s*<FieldRef[^>]*Name="([^"]+)"/i.exec(xml);
      views.push({ id: String(v.Id), title: String(v.Title), isDefault: v.DefaultView === true, columns, groupBy: group ? labelOf(group[1]) : null, ids });
    }
  } catch {
    // Sin vistas no pasa nada: se ve la lista entera.
  }

  const base = u.origin + listPath;
  return {
    results,
    list: {
      title: info.Title,
      url: base,
      at: new Date().toISOString(),
      views,
      fields: fields.map((f) => ({
        name: f.InternalName,
        label: f.InternalName === 'Title' ? 'Título' : f.Title,
        type: f.TypeAsString,
        choices: f.Choices ?? [],
        editable: EDIT.indexOf(f.TypeAsString) >= 0,
        format: f.TypeAsString === 'DateTime' ? (f.DisplayFormat === 1 ? 'datetime' : 'date') : undefined,
        required: f.Required === true,
        defaultValue: f.DefaultValue == null ? null : String(f.DefaultValue),
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
    },
  };
}
