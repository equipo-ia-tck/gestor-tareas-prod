import { describe, expect, it, vi } from 'vitest';
import {
  guessCategory, guessStatusColumn, listMoves, listPushes, statusValues, taskFromListItem, valueForCategory, type MsListConfig,
} from '../src/domain/msList';
import {
  addPending, isSharePointOrigin, normalizeListUrl, parseSnapshot, remainingPending, withPending, type MsListChange, type MsListItem,
} from '../src/domain/msListParse';
import { DEFAULT_ITEM_TYPES } from '../src/domain/workflows';
import { bookmarkletCode } from '../src/features/mslist/bookmarklet';
import { makeTask } from './factories';

const LIST = 'https://wpp.sharepoint.com/sites/equipo/Lists/Contratos';
const item = (id: string, title: string, fields: Record<string, string>): MsListItem => ({ id, title, fields, url: `${LIST}/DispForm.aspx?ID=${id}`, modified: null });
const items = [
  item('7', 'Revisar contrato', { Estado: 'En curso', Responsable: 'Ana Ruiz', 'Fecha límite': '2026-11-20', Etiquetas: 'Legal, Urgente' }),
  item('8', 'Preparar demo', { Estado: 'Pendiente' }),
  item('9', 'Elemento 9', { Estado: 'Completado' }),
];

describe('Microsoft List: lo que manda el marcador', () => {
  it('solo acepta SharePoint Online y valida la forma', () => {
    expect(isSharePointOrigin('https://wpp.sharepoint.com')).toBe(true);
    expect(isSharePointOrigin('https://wpp-my.sharepoint.com')).toBe(true);
    expect(isSharePointOrigin('https://sharepoint.com.evil.es')).toBe(false);
    expect(isSharePointOrigin('http://wpp.sharepoint.com')).toBe(false);
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ url: 'https://evil.es/x', fields: [], items: [] })).toBeNull();
    const s = parseSnapshot({
      title: 'Contratos', url: LIST, at: '2026-11-20T10:00:00Z',
      fields: [{ name: 'Estado', label: 'Estado', type: 'Choice', choices: ['Pendiente', 'Hecho'], editable: true }, { name: '', label: 'x' }],
      items: [{ id: '7', title: '', fields: { Estado: 'Hecho', Vacía: '  ' }, url: 'https://evil.es/7' }, { id: 'abc', title: 'mal' }],
    })!;
    expect(s.fields).toHaveLength(1);
    expect(s.items).toEqual([{ id: '7', title: 'Elemento 7', fields: { Estado: 'Hecho' }, url: null, modified: null }]);
  });

  it('cambios pendientes: el último de cada campo, se ven puestos y se quitan al aplicarse', () => {
    const at = '2026-11-20T10:00:00Z';
    let pending: MsListChange[] = [];
    pending = addPending(pending, { id: '8', field: 'Estado', value: 'En curso', at }, items);
    pending = addPending(pending, { id: '8', field: 'Estado', value: 'Completado', at }, items);
    pending = addPending(pending, { id: '7', field: 'Título', value: 'Revisar contrato v2', at }, items);
    pending = addPending(pending, { id: '7', field: 'Responsable', value: 'Ana Ruiz', at }, items); // igual que en la lista
    expect(pending.map((c) => [c.id, c.field, c.value])).toEqual([['8', 'Estado', 'Completado'], ['7', 'Título', 'Revisar contrato v2']]);
    const shown = withPending(items, pending);
    expect(shown[0].title).toBe('Revisar contrato v2');
    expect(shown[1].fields.Estado).toBe('Completado');
    // El 8 se aplicó; el 7 falló y se queda para la próxima vez.
    expect(remainingPending(pending, items, [{ key: '8|Estado', ok: true }, { key: '7|Título', ok: false, error: 'x' }])).toEqual([pending[1]]);
    // Si la lista ya lo refleja (lo cambió otra persona igual), también se quita.
    expect(remainingPending(pending, [items[0], { ...items[1], fields: { Estado: 'Completado' } }], [])).toEqual([pending[1]]);
  });
});

describe('Microsoft List: en el gestor', () => {
  const config: MsListConfig = { statusColumn: 'Estado', map: { Pendiente: 'todo' } };
  const types = DEFAULT_ITEM_TYPES;

  it('adivina la columna de estado y la categoría de cada valor', () => {
    expect(guessStatusColumn(items)).toBe('Estado');
    const other: MsListItem[] = [1, 2, 3].map((i) => item(String(i), 't', { Notas: `texto ${i}`, 'Fase actual': i === 3 ? 'Cerrada' : 'Abierta' }));
    expect(guessStatusColumn(other)).toBe('Fase actual');
    expect(['Pendiente', 'En curso', 'En espera', 'Completado', 'Cerrada'].map(guessCategory)).toEqual(['todo', 'doing', 'blocked', 'done', 'done']);
    expect(statusValues(items, 'Estado')).toEqual(['En curso', 'Pendiente', 'Completado']);
    expect(valueForCategory('done', statusValues(items, 'Estado'), config)).toBe('Completado');
    expect(valueForCategory('accepted', statusValues(items, 'Estado'), config)).toBe('Completado');
    expect(valueForCategory('blocked', statusValues(items, 'Estado'), config)).toBeNull();
  });

  it('la lista manda: mueve las tareas enlazadas a la categoría de su elemento', () => {
    const linked = makeTask({ external_id: 'LS-7' }); // en la lista: En curso
    const same = makeTask({ external_id: 'LS-8' }); // en la lista: Pendiente, ya está por hacer
    const accepted = makeTask({ external_id: 'LS-9', status: 'done', state_id: 'task-accepted' }); // Completado = hecho
    const moves = listMoves([linked, same, accepted, makeTask({ external_id: 'US1' })], items, config, types);
    expect(moves.map((m) => [m.task.external_id, m.stateId])).toEqual([['LS-7', 'task-doing']]);
    expect(listMoves([linked], items, { statusColumn: null, map: {} }, types)).toEqual([]);
  });

  it('al mover una tarea enlazada aquí (o deshacerlo), pide el cambio en la lista', () => {
    const before = makeTask({ external_id: 'LS-8' });
    const after = { ...before, state_id: 'task-done', status: 'done' as const };
    expect(listPushes([{ table: 'tasks', before, after }], false, types)).toEqual([{ id: '8', category: 'done' }]);
    expect(listPushes([{ table: 'tasks', before, after }], true, types)).toEqual([{ id: '8', category: 'todo' }]);
    expect(listPushes([{ table: 'tasks', before: makeTask(), after: makeTask() }], false, types)).toEqual([]);
  });

  it('crea la tarea con el título, el enlace y las demás columnas en las notas', () => {
    expect(taskFromListItem(items[0], config, 'p1', 'Contratos')).toMatchObject({
      title: 'Revisar contrato', external_id: 'LS-7', url: `${LIST}/DispForm.aspx?ID=7`, project_id: 'p1',
      notes: 'De Contratos (elemento 7)\nResponsable: Ana Ruiz\nFecha límite: 2026-11-20\nEtiquetas: Legal, Urgente',
    });
  });
});

/** SharePoint de mentira: lo justo de la API REST que usa el marcador. */
function fakeSharePoint() {
  const merges: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const calls: string[] = [];
  const creates: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const viewQueries: { query: { ViewXml: string } }[] = [];
  const fields = [
    { InternalName: 'Title', Title: 'Title', TypeAsString: 'Text', ReadOnlyField: false },
    { InternalName: 'Estado', Title: 'Estado', TypeAsString: 'Choice', Choices: ['Pendiente', 'En curso', 'Hecho'], ReadOnlyField: false },
    { InternalName: 'Responsable', Title: 'Responsable', TypeAsString: 'User', ReadOnlyField: false },
    { InternalName: 'Fecha_x0020_l_x00ed_mite', Title: 'Fecha límite', TypeAsString: 'DateTime', DisplayFormat: 0, ReadOnlyField: false },
    { InternalName: 'Horas', Title: 'Horas', TypeAsString: 'Number', ReadOnlyField: false },
    { InternalName: 'ContentType', Title: 'Tipo de contenido', TypeAsString: 'Computed', ReadOnlyField: true },
  ];
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json;odata=nometadata' } });
    if (url.endsWith('/_api/contextinfo')) return json({ FormDigestValue: 'digest-1' });
    if (url.includes('$select=ListItemEntityTypeFullName')) return json({ ListItemEntityTypeFullName: 'SP.Data.ContratosListItem' });
    if (init.method === 'POST' && /\/items\?/.test(url)) {
      creates.push({ body: JSON.parse(init.body!), headers: init.headers! });
      return json({ Id: 9 });
    }
    if (init.method === 'POST' && /\/items\(\d+\)/.test(url)) {
      merges.push({ url, body: JSON.parse(init.body!), headers: init.headers! });
      return new Response(null, { status: 204 });
    }
    if (url.includes('/fields?')) return json({ value: fields });
    if (url.includes('/views?')) {
      return json({ value: [{ Id: 'v1', Title: 'Seguimiento Track', DefaultView: false,
        ListViewXml: '<View Name="v1"><Query><GroupBy Collapse="TRUE"><FieldRef Name="Estado" /></GroupBy><OrderBy><FieldRef Name="ID" Ascending="FALSE" /></OrderBy></Query><ViewFields><FieldRef Name="LinkTitle" /><FieldRef Name="Estado" /><FieldRef Name="Horas" /><FieldRef Name="Inventada" /></ViewFields><RowLimit Paged="TRUE">30</RowLimit></View>' }] });
    }
    if (url.includes('/GetItems?')) {
      viewQueries.push(JSON.parse(init.body!));
      return json({ value: [{ Id: 8 }, { Id: 7 }] });
    }
    if (url.includes('/items?') && url.includes('page=2')) return json({ value: [{ Id: 8, Title: 'Preparar demo', Estado: 'Pendiente', Responsable: null }] });
    if (url.includes('/items?')) {
      return json({
        value: [{ Id: 7, Title: 'Revisar contrato', Estado: 'En curso', Responsable: { Title: 'Ana Ruiz' }, Fecha_x0020_l_x00ed_mite: '2026-11-20T23:00:00Z', Horas: 3 }],
        'odata.nextLink': `${url}&page=2`,
      });
    }
    if (url.includes('GetList(@u)?$select=Title')) return json({ Title: 'Contratos' });
    return new Response('no', { status: 404 });
  };
  return { fetch, merges, calls, viewQueries, creates };
}

describe('Microsoft List: el marcador', () => {
  it('abre Marea, aplica los cambios pendientes, lee la lista entera, se la manda y se queda conectado', async () => {
    const app = 'https://marea.example';
    const sp = fakeSharePoint();
    const posted: { data: Record<string, unknown>; origin: string }[] = [];
    const popup = { postMessage: (data: Record<string, unknown>, origin: string) => posted.push({ data, origin }) };
    const listeners: ((e: unknown) => void)[] = [];
    const box = { style: {}, textContent: '', id: '', remove() {} };
    const win: Record<string, unknown> = {
      open: (url: string, name: string) => { expect([url, name]).toEqual([`${app}/#/lista`, 'marea-lista']); return popup; },
      addEventListener: (_: string, l: (e: unknown) => void) => listeners.push(l),
      removeEventListener: () => {},
    };
    const doc = { getElementById: () => null, createElement: () => box, body: { appendChild: () => {} } };
    const loc = { origin: 'https://wpp.sharepoint.com', pathname: '/sites/equipo/Lists/Contratos/AllItems.aspx' };
    const reads = () => sp.calls.filter((u) => u.includes('/items?')).length;
    // El código tal cual se pega en el marcador: sin nada de fuera.
    new Function('window', 'document', 'location', 'fetch', 'DOMParser', bookmarkletCode(app))(win, doc, loc, sp.fetch, class {});
    expect(listeners).toHaveLength(1);
    // Un mensaje que no es de Marea no hace nada.
    listeners[0]({ origin: 'https://evil.es', source: popup, data: { type: 'marea-lista:ready', changes: [] } });
    listeners[0]({
      origin: app, source: popup,
      data: { type: 'marea-lista:ready', changes: [
        { id: '7', field: 'Estado', value: 'Hecho' }, { id: '7', field: 'Título', value: 'Revisar contrato v2' },
        { id: '7', field: 'Horas', value: '2,5' }, { id: '8', field: 'Responsable', value: 'Luis' },
      ] },
    });
    await vi.waitFor(() => expect(posted.some((p) => p.data.type === 'marea-lista:data')).toBe(true));
    // Sigue conectado: si Marea no tiene nada que pedir, no lee; con cambios o al tocar la relectura, sí.
    const readsAfterFirst = reads();
    listeners[0]({ origin: app, source: popup, data: { type: 'marea-lista:ready', changes: [], wantList: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(readsAfterFirst);
    listeners[0]({ origin: app, source: popup, data: { type: 'marea-lista:ready', changes: [{ id: '8', field: 'Estado', value: 'En curso' }] } });
    await vi.waitFor(() => expect(posted.filter((p) => p.data.type === 'marea-lista:data')).toHaveLength(2));
    expect(sp.merges.at(-1)!.body).toEqual({ Estado: 'En curso' });
    (win.__mareaListaStop as () => void)();
    expect(sp.merges.slice(0, 3).map((m) => m.body)).toEqual([{ Estado: 'Hecho' }, { Title: 'Revisar contrato v2' }, { Horas: 2.5 }]);
    expect(sp.merges[0].headers).toMatchObject({ 'X-HTTP-Method': 'MERGE', 'X-RequestDigest': 'digest-1', 'IF-MATCH': '*' });
    expect(sp.merges[0].url).toContain("/sites/equipo/_api/web/GetList(@u)/items(7)?@u='%2Fsites%2Fequipo%2FLists%2FContratos'");
    const sent = posted.find((p) => p.data.type === 'marea-lista:data')!;
    expect((posted.filter((p) => p.data.type === 'marea-lista:data')[1].data.results as unknown[])).toHaveLength(1);
    expect(sent.origin).toBe(app);
    expect((sent.data.results as { ok: boolean }[]).map((r) => r.ok)).toEqual([true, true, true, false]);
    const snapshot = parseSnapshot(sent.data.list)!;
    expect(snapshot.title).toBe('Contratos');
    expect(snapshot.views).toEqual([{ id: 'v1', title: 'Seguimiento Track', isDefault: false, columns: ['Título', 'Estado', 'Horas'], groupBy: 'Estado', ids: ['8', '7'] }]);
    // La vista se pide entera (sin su tope de 30 por página) y con su filtro y orden.
    expect(sp.viewQueries[0].query.ViewXml).toContain('<RowLimit Paged="TRUE">5000</RowLimit></View>');
    expect(sp.viewQueries[0].query.ViewXml).not.toContain('>30<');
    expect(snapshot.url).toBe(LIST);
    expect(snapshot.fields.map((f) => [f.label, f.editable])).toEqual([
      ['Título', true], ['Estado', true], ['Responsable', false], ['Fecha límite', true], ['Horas', true],
    ]);
    expect(snapshot.items).toEqual([
      // Fecha a medianoche de Madrid guardada en UTC → el día de Madrid.
      { id: '7', title: 'Revisar contrato', fields: { Estado: 'En curso', Responsable: 'Ana Ruiz', 'Fecha límite': '2026-11-21', Horas: '3' }, url: `${LIST}/DispForm.aspx?ID=7`, modified: null },
      { id: '8', title: 'Preparar demo', fields: { Estado: 'Pendiente' }, url: `${LIST}/DispForm.aspx?ID=8`, modified: null },
    ]);
  });

  it('fuera de una lista avisa y no abre nada', () => {
    const box = { style: {}, textContent: '', id: '', remove() {} };
    const open = vi.fn();
    new Function('window', 'document', 'location', 'fetch', 'DOMParser', bookmarkletCode('https://marea.example'))(
      { open, addEventListener() {}, removeEventListener() {} },
      { getElementById: () => null, createElement: () => box, body: { appendChild() {} } },
      { origin: 'https://wpp.sharepoint.com', pathname: '/sites/equipo/SitePages/Inicio.aspx' }, fetch, class {});
    expect(open).not.toHaveBeenCalled();
    expect(box.textContent).toMatch(/Abre la lista/);
  });
});

describe('Microsoft List: conexión con el marcador', () => {
  it('conectado si ha preguntado hace poco; la lista entera, cada 2 minutos', async () => {
    const { isConnected, wantsList, CONTACT_MS, LIST_EVERY_MS } = await import('../src/features/mslist/listaStore');
    const now = Date.parse('2026-11-23T10:00:00Z');
    const snapshot = { title: 'L', url: LIST, fields: [], items: [], views: [], at: new Date(now - 60_000).toISOString() };
    expect(isConnected({ snapshot, pending: [], creates: [], errors: {}, contactAt: now - 5000, listUrl: null, ext: { okAt: 0, error: null } }, now)).toBe(true);
    expect(isConnected({ snapshot, pending: [], creates: [], errors: {}, contactAt: now - CONTACT_MS - 1, listUrl: null, ext: { okAt: 0, error: null } }, now)).toBe(false);
    expect(wantsList({ snapshot, pending: [], creates: [], errors: {}, contactAt: 0, listUrl: null, ext: { okAt: 0, error: null } }, now)).toBe(false);
    expect(wantsList({ snapshot, pending: [], creates: [], errors: {}, contactAt: 0, listUrl: null, ext: { okAt: 0, error: null } }, now + LIST_EVERY_MS)).toBe(true);
    expect(wantsList({ snapshot: null, pending: [], creates: [], errors: {}, contactAt: 0, listUrl: null, ext: { okAt: 0, error: null } }, now)).toBe(true);
  });
});

describe('Microsoft List: la extensión', () => {
  it('normaliza la dirección que se pega', () => {
    expect(normalizeListUrl(`${LIST}/AllItems.aspx?viewid=1&FilterField1=x`)).toBe(LIST);
    expect(normalizeListUrl('https://wpp.sharepoint.com/sites/equipo/Lists/Mi%20lista/DispForm.aspx?ID=3')).toBe('https://wpp.sharepoint.com/sites/equipo/Lists/Mi lista');
    expect(normalizeListUrl('https://evil.es/sites/x/Lists/Y')).toBeNull();
    expect(normalizeListUrl('https://wpp.sharepoint.com/sites/equipo/SitePages/Inicio.aspx')).toBeNull();
    expect(normalizeListUrl('no es una dirección')).toBeNull();
  });

  /** El background.js tal cual lo empaqueta scripts/build-extension.mjs, con un Chrome de mentira. */
  async function background(fetch: unknown) {
    const { readFileSync } = await import('node:fs');
    const { spWork } = await import('../src/features/mslist/spWork');
    const { spDocs } = await import('../src/features/assistant/spDocs');
    const code = readFileSync('extension/background.template.js', 'utf8').replaceAll('/*SPWORK*/', spWork.toString()).replaceAll('/*SPDOCS*/', spDocs.toString());
    let onMessage: ((msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean) | null = null;
    const injected: unknown[][] = [];
    const created: unknown[] = [];
    const chrome = {
      runtime: { id: 'ext', onMessage: { addListener: (l: typeof onMessage) => { onMessage = l; } } },
      tabs: {
        query: async () => [],
        create: async (o: unknown) => { created.push(o); return { id: 9, status: 'complete' }; },
        onUpdated: { addListener: (l: (id: number, info: { status: string }) => void) => setTimeout(() => l(9, { status: 'complete' }), 0), removeListener() {} },
      },
      scripting: {
        // En la pestaña de SharePoint la sesión sí vale: se ejecuta con el SharePoint de mentira «bueno».
        executeScript: async ({ func, args }: { func: (...a: unknown[]) => Promise<unknown>; args: unknown[] }) => {
          injected.push(args);
          const real = globalThis.fetch;
          globalThis.fetch = fakeSharePoint().fetch as unknown as typeof globalThis.fetch;
          // Como Chrome: la función viaja como texto, así que no puede depender de nada de fuera.
          const inPage = new Function(`return (${func.toString()})`)() as typeof func;
          try { return [{ result: await inPage(...args) }]; } finally { globalThis.fetch = real; }
        },
      },
    };
    new Function('chrome', 'fetch', code)(chrome, fetch);
    const ask = (msg: unknown, sender: unknown = { id: 'ext', tab: { id: 1 } }) => new Promise<Record<string, unknown> | undefined>((resolve) => {
      const async = onMessage!(msg, sender, (r) => resolve(r as Record<string, unknown>));
      if (!async) resolve(undefined);
    });
    return { ask, injected, created };
  }

  it('en segundo plano con la sesión de SharePoint', async () => {
    const sp = fakeSharePoint();
    const ext = await background(sp.fetch);
    const r = (await ext.ask({ type: 'marea-ext:sync', listUrl: LIST, changes: [{ id: '7', field: 'Estado', value: 'Hecho' }], wantList: false }))!;
    expect(r.via).toBe('background');
    expect(r.results).toEqual([{ key: '7|Estado', ok: true }]);
    expect(parseSnapshot(r.list)!.items).toHaveLength(2);
    expect(sp.merges.map((m) => m.body)).toEqual([{ Estado: 'Hecho' }]);
    expect(ext.created).toEqual([]);
    // Nada que hacer: no lee.
    expect((await ext.ask({ type: 'marea-ext:sync', listUrl: LIST, changes: [], wantList: false }))!.list).toBeNull();
  });

  it('si SharePoint no deja en segundo plano, lo hace en una pestaña fijada de la lista', async () => {
    const ext = await background(async () => new Response('', { status: 403 }));
    const r = (await ext.ask({ type: 'marea-ext:sync', listUrl: LIST, changes: [], wantList: true }))!;
    expect(r.via).toBe('tab');
    expect(ext.created).toEqual([{ url: LIST, active: false, pinned: true }]);
    expect(ext.injected).toEqual([[LIST, [], true]]);
    expect(parseSnapshot(r.list)!.title).toBe('Contratos');
  });

  it('crea elementos nuevos con su tipo de SharePoint; lo que no se puede rellenar se dice', async () => {
    const sp = fakeSharePoint();
    const ext = await background(sp.fetch);
    const r = (await ext.ask({ type: 'marea-ext:sync', listUrl: LIST, wantList: false, changes: [
      { create: true, key: 'new:a', values: { Título: 'Nuevo contrato', Estado: 'En curso', Horas: '1,5', Responsable: 'Ana' } },
      { create: true, key: 'new:b', values: { Estado: 'Hecho' } },
    ] }))!;
    expect(r.results).toEqual([
      { key: 'new:a', ok: true, id: '9', skipped: ['Responsable'] },
      { key: 'new:b', ok: false, error: 'Falta el título.' },
    ]);
    expect(sp.creates).toHaveLength(1);
    expect(sp.creates[0].body).toEqual({ __metadata: { type: 'SP.Data.ContratosListItem' }, Title: 'Nuevo contrato', Estado: 'En curso', Horas: 1.5 });
    expect(sp.creates[0].headers['Content-Type']).toBe('application/json;odata=verbose');
    // Después de un alta se relee la lista (para enseñarla ya con el elemento).
    expect(r.list).not.toBeNull();
  });

  it('documentación: solo operaciones conocidas y en SharePoint', async () => {
    const ext = await background(async () => new Response(JSON.stringify({ Title: 'Equipo', Url: 'https://wpp.sharepoint.com/sites/Equipo' }), { headers: { 'content-type': 'application/json' } }));
    expect(await ext.ask({ type: 'marea-ext:docs', op: 'borrar', args: { siteUrl: 'https://wpp.sharepoint.com/sites/Equipo' } })).toEqual({ error: 'Petición de documentación no válida.' });
    expect(await ext.ask({ type: 'marea-ext:docs', op: 'search', args: { siteUrl: 'https://evil.es' } })).toEqual({ error: 'Petición de documentación no válida.' });
    expect(await ext.ask({ type: 'marea-ext:docs', op: 'search', args: { siteUrl: 'https://wpp.sharepoint.com/sites/Equipo', query: 'x' } })).toEqual({ value: { hits: [], loose: false } });
  });

  it('rechaza lo que no es de Marea o no es una lista de SharePoint', async () => {
    const ext = await background(fakeSharePoint().fetch);
    expect(await ext.ask({ type: 'marea-ext:sync', listUrl: LIST }, { id: 'otra', tab: { id: 1 } })).toBeUndefined();
    expect(await ext.ask({ type: 'marea-ext:sync', listUrl: 'https://evil.es/x/Lists/Y' })).toEqual({ error: 'Esa dirección no es de una lista de SharePoint.' });
  });
});

describe('Microsoft List: buscar, filtrar, agrupar y ordenar', async () => {
  const {
    activeFilters, facetValues, filterableColumns, groupItems, itemsInView, matchesFilters, matchesText, sortItems,
  } = await import('../src/domain/msListView');
  const fields = [
    { name: 'Title', label: 'Título', type: 'Text', choices: [], editable: true },
    { name: 'Estado', label: 'Estado', type: 'Choice', choices: ['En curso', 'Dependencia', 'Backlog', 'Completada'], editable: true },
    { name: 'Equipo', label: 'Equipo responsable', type: 'MultiChoice', choices: ['Omniexperiencia', 'DS&A'], editable: true },
    { name: 'Fecha', label: 'Fecha estimada', type: 'DateTime', choices: [], editable: true, format: 'date' as const },
    { name: 'Prio', label: 'Prioridad Tarea', type: 'Number', choices: [], editable: true },
    { name: 'Coment', label: 'Comentarios', type: 'Note', choices: [], editable: true },
  ];
  const rows = [
    item('1', 'Medición Imagin', { Estado: 'Backlog', 'Equipo responsable': 'DS&A', 'Fecha estimada': '2026-12-01', 'Prioridad Tarea': '2' }),
    item('2', 'Banksy', { Estado: 'En curso', 'Equipo responsable': 'Omniexperiencia, DS&A', 'Fecha estimada': '2026-11-20', 'Prioridad Tarea': '1' }),
    item('3', 'Incidencia login', { Estado: 'En curso', 'Prioridad Tarea': '10', Comentarios: 'pendiente de validación en PRE' }),
    item('4', 'Fuentes de tráfico', { Estado: 'Completada', 'Equipo responsable': 'Omniexperiencia' }),
  ];

  it('columnas para filtrar y sus valores con recuento, en el orden de las opciones', () => {
    expect(filterableColumns(fields, rows).map((f) => f.label)).toEqual(['Estado', 'Equipo responsable', 'Fecha estimada', 'Prioridad Tarea']);
    expect(facetValues(rows, fields[1])).toEqual([{ value: 'En curso', count: 2 }, { value: 'Backlog', count: 1 }, { value: 'Completada', count: 1 }]);
    // Varias opciones: cada una cuenta por separado; sin valor, «(Vacío)» al final.
    expect(facetValues(rows, fields[2])).toEqual([{ value: 'Omniexperiencia', count: 2 }, { value: 'DS&A', count: 2 }, { value: '', count: 1 }]);
    expect(facetValues(rows, fields[4]).map((f) => f.value)).toEqual(['1', '2', '10', '']);
  });

  it('filtros: misma columna = cualquiera; columnas distintas = todas; fechas por rango; vacío', () => {
    const pass = (f: Parameters<typeof matchesFilters>[1]) => rows.filter((it) => matchesFilters(it, f, fields)).map((it) => it.id);
    expect(pass({ Estado: { values: ['En curso', 'Backlog'] } })).toEqual(['1', '2', '3']);
    expect(pass({ Estado: { values: ['En curso'] }, 'Equipo responsable': { values: ['DS&A'] } })).toEqual(['2']);
    expect(pass({ 'Equipo responsable': { values: [''] } })).toEqual(['3']);
    expect(pass({ 'Fecha estimada': { from: '2026-11-25' } })).toEqual(['1']);
    expect(pass({ 'Fecha estimada': { to: '2026-11-30' } })).toEqual(['2']);
    expect(activeFilters({ Estado: { values: [] }, 'Fecha estimada': { from: '2026-01-01' } })).toBe(1);
    expect(rows.filter((it) => matchesText(it, 'validacion pre')).map((it) => it.id)).toEqual(['3']);
  });

  it('agrupar y ordenar como en SharePoint', () => {
    expect(groupItems(rows, 'Estado', fields).map((g) => [g.value, g.items.map((it) => it.id)])).toEqual([
      ['En curso', ['2', '3']], ['Backlog', ['1']], ['Completada', ['4']],
    ]);
    expect(groupItems(rows, 'Fecha estimada', fields).map((g) => g.value)).toEqual(['2026-11-20', '2026-12-01', '']);
    expect(sortItems(rows, 'Prioridad Tarea', 'asc', fields).map((it) => it.id)).toEqual(['2', '1', '3', '4']);
    expect(sortItems(rows, 'Prioridad Tarea', 'desc', fields).map((it) => it.id)).toEqual(['3', '1', '2', '4']);
    expect(sortItems(rows, 'Estado', 'asc', fields).map((it) => it.id)).toEqual(['2', '3', '1', '4']);
    expect(sortItems(rows, 'ID', 'desc', fields).map((it) => it.id)).toEqual(['4', '3', '2', '1']);
    expect(sortItems([rows[2], rows[0]], '', 'asc', fields, true).map((it) => it.id)).toEqual(['3', '1']);
  });

  it('una vista deja sus elementos en su orden', () => {
    const view = { id: 'v', title: 'Seguimiento Track', isDefault: false, columns: ['Estado'], groupBy: null, ids: ['3', '1', '99'] };
    expect(itemsInView(rows, view).map((it) => it.id)).toEqual(['3', '1']);
    expect(itemsInView(rows, null)).toBe(rows);
  });
});

it('la versión de la extensión que conoce Marea es la del manifiesto', async () => {
  const { readFileSync } = await import('node:fs');
  const { LATEST_EXTENSION, isOutdated } = await import('../src/features/mslist/extension');
  expect(JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version).toBe(LATEST_EXTENSION);
  expect(isOutdated('1.0.0')).toBe(true);
  expect(isOutdated(LATEST_EXTENSION)).toBe(false);
  expect(isOutdated('9.0.0')).toBe(false);
  expect(isOutdated(null)).toBe(false);
});

describe('Microsoft List: crear con petición', async () => {
  const { parseListRequest } = await import('../src/domain/msListRequest');
  const fields = [
    { name: 'Title', label: 'Título', type: 'Text', choices: [], editable: true, required: true },
    { name: 'Madre', label: 'Tarea madre', type: 'Choice', choices: ['MEJORAS MEDICION', 'BANKSY', 'CAMPAÑAS INTERNAS', 'INCIDENCIAS'], editable: true },
    { name: 'Estado', label: 'Estado', type: 'Choice', choices: ['En curso', 'Dependencia', 'Backlog', 'Completada'], editable: true },
    { name: 'Fecha', label: 'Fecha estimada', type: 'DateTime', choices: [], editable: true, format: 'date' as const },
    { name: 'Equipo', label: 'Equipo responsable', type: 'MultiChoice', choices: ['Omniexperiencia', 'DS&A'], editable: true },
    { name: 'Prio', label: 'Prioridad Tarea', type: 'Choice', choices: ['1', '2', '3', '4', '5'], editable: true },
    { name: 'Coment', label: 'Comentarios o bloqueos', type: 'Note', choices: [], editable: true },
    { name: 'Resp', label: 'Responsable', type: 'User', choices: [], editable: false },
  ];
  const today = '2026-11-23'; // lunes
  const parse = (t: string) => parseListRequest(t, fields, today);

  it('columna y valor, por su nombre o su primera palabra', () => {
    expect(parse('crear Revisar etiquetado Imagin, estado en curso, prioridad 1, equipo responsable DS&A y Omniexperiencia, fecha estimada el viernes')).toEqual({
      values: {
        Título: 'Revisar etiquetado Imagin', Estado: 'En curso', 'Prioridad Tarea': '1',
        'Equipo responsable': 'Omniexperiencia, DS&A', 'Fecha estimada': '2026-11-27',
      },
      unknown: [],
    });
  });

  it('opciones sueltas, fecha suelta, título entre comillas y textos libres', () => {
    expect(parse('"Medir campaña Navidad" banksy backlog para el 15 de diciembre comentarios o bloqueos: depende de la de Imagin, en PRE').values).toEqual({
      Título: 'Medir campaña Navidad', 'Tarea madre': 'BANKSY', Estado: 'Backlog', 'Fecha estimada': '2026-12-15',
      'Comentarios o bloqueos': 'depende de la de Imagin, en PRE',
    });
    expect(parse('nueva tarea Arreglar login incidencias').values).toEqual({ Título: 'Arreglar login', 'Tarea madre': 'INCIDENCIAS' });
  });

  it('lo que no encaja va a «no entendido»', () => {
    const r = parse('Algo estado inventado responsable Ana');
    expect(r.values).toEqual({ Título: 'Algo' });
    expect(r.unknown).toEqual(['Estado inventado', 'Responsable Ana (no se puede rellenar desde Marea)']);
  });
});

describe('Microsoft List: altas pendientes en Marea', () => {
  it('se mandan antes que los cambios, se quitan al crearse y devuelven su ID', async () => {
    const store = await import('../src/features/mslist/listaStore');
    store.forgetLista();
    const a = store.queueCreate({ Título: 'Uno', Estado: 'Backlog' }, { projectId: 'p1' });
    const b = store.queueCreate({ Título: 'Dos' }, null);
    store.queueChange('7', 'Estado', 'Hecho');
    expect(store.outgoing()).toEqual([
      { create: true, key: a.key, values: { Título: 'Uno', Estado: 'Backlog' } },
      { create: true, key: b.key, values: { Título: 'Dos' } },
      expect.objectContaining({ id: '7', field: 'Estado', value: 'Hecho' }),
    ]);
    const snapshot = { title: 'L', url: LIST, fields: [], views: [], at: new Date().toISOString(), items: [...items, item('9', 'Uno', { Estado: 'Backlog' })] };
    const created = store.receiveSnapshot(snapshot, [{ key: a.key, ok: true, id: '9' }, { key: b.key, ok: false, error: 'Columna obligatoria' }]);
    expect(created).toEqual([{ create: a, id: '9', skipped: [] }]);
    expect(store.getListaState().creates).toEqual([b]);
    // El que falló no se reintenta cada pocos segundos, solo con la relectura.
    expect(store.outgoing().some((c) => (c as { key?: string }).key === b.key)).toBe(false);
    expect(store.outgoing(store.getListaState(), true).some((c) => (c as { key?: string }).key === b.key)).toBe(true);
    store.forgetLista();
  });
});

describe('Microsoft List: tipo «Lista» en el Tablero', async () => {
  const { LIST_TYPE_ID, listItemType, listTypeChanged } = await import('../src/domain/msList');
  const config: MsListConfig = { statusColumn: 'Estado', map: {} };
  const type = listItemType(['Backlog', 'En curso', 'Dependencia', 'Completada'], config, 9);
  const types = [...DEFAULT_ITEM_TYPES, type];
  const rows = [item('1', 'Uno', { Estado: 'Dependencia' }), item('2', 'Dos', { Estado: 'Backlog' })];

  it('un estado por valor de la lista, con su grupo', () => {
    expect(type).toMatchObject({ id: LIST_TYPE_ID, name: 'Lista', short: 'LS', order: 9 });
    expect(type.states.map((st) => [st.id, st.name, st.category])).toEqual([
      ['lista-backlog', 'Backlog', 'todo'], ['lista-en-curso', 'En curso', 'doing'],
      ['lista-dependencia', 'Dependencia', 'blocked'], ['lista-completada', 'Completada', 'done'],
    ]);
    // Sin un estado de Hecho (o de Por hacer) en la lista, se añade para poder completar y reabrir.
    expect(listItemType(['Abierta', 'En curso'], config, 1).states.map((st) => st.name)).toEqual(['Abierta', 'En curso', 'Hecho']);
    expect(listTypeChanged(undefined, type)).toBe(true);
    expect(listTypeChanged({ ...type, color: '#000', order: 2 }, type)).toBe(false);
    expect(listTypeChanged(type, listItemType(['Backlog', 'En curso', 'Completada'], config, 9))).toBe(true);
  });

  it('la lista manda con el estado exacto, no solo el grupo', () => {
    const t1 = makeTask({ external_id: 'LS-1', type_id: LIST_TYPE_ID, state_id: 'lista-backlog' });
    const t2 = makeTask({ external_id: 'LS-2', type_id: LIST_TYPE_ID, state_id: 'lista-backlog' });
    expect(listMoves([t1, t2], rows, config, types).map((m) => [m.task.external_id, m.stateId])).toEqual([['LS-1', 'lista-dependencia']]);
  });

  it('al cambiar de estado aquí se manda el valor con su nombre, aunque sea del mismo grupo', () => {
    const before = makeTask({ external_id: 'LS-2', type_id: LIST_TYPE_ID, state_id: 'lista-backlog' });
    const after = { ...before, state_id: 'lista-dependencia' };
    expect(listPushes([{ table: 'tasks', before, after }], false, types)).toEqual([{ id: '2', category: 'blocked', stateName: 'Dependencia' }]);
    const two = listItemType(['Backlog', 'Pendiente de revisar', 'Completada'], config, 9);
    const b = makeTask({ external_id: 'LS-3', type_id: LIST_TYPE_ID, state_id: 'lista-backlog' });
    expect(listPushes([{ table: 'tasks', before: b, after: { ...b, state_id: 'lista-pendiente-de-revisar' } }], false, [...DEFAULT_ITEM_TYPES, two]))
      .toEqual([{ id: '3', category: 'todo', stateName: 'Pendiente de revisar' }]);
  });

  it('la tarea de un elemento nuevo puede ser ya del tipo Lista', () => {
    expect(taskFromListItem(rows[0], config, null, 'L', LIST_TYPE_ID).type_id).toBe(LIST_TYPE_ID);
    expect(taskFromListItem(rows[0], config, null).type_id).toBe('task');
  });
});

describe('Microsoft List: tipo «Lista» en el repositorio', () => {
  it('lo crea la sesión de admin, pasa a él las tareas de la lista y se ajusta si cambian los estados', async () => {
    const { TasksDB } = await import('../src/data/db');
    const { DexieRepository } = await import('../src/data/repository');
    const { LIST_TYPE_ID, listItemType } = await import('../src/domain/msList');
    const repo = new DexieRepository(new TasksDB(`lista-${crypto.randomUUID()}`));
    const config: MsListConfig = { statusColumn: 'Estado', map: {} };
    const doing = await repo.createTask({ title: 'De la lista', external_id: 'LS-4' });
    await repo.setState(doing.id, 'task-doing');
    const other = await repo.createTask({ title: 'Otra', external_id: 'US1' });
    // Sin el tipo (y sin ser admin) no cambia nada.
    await repo.ensureListType(null);
    expect((await repo.getTask(doing.id))!.type_id).toBe('task');
    await repo.ensureListType(listItemType(['Backlog', 'En curso', 'Dependencia', 'Completada'], config, 50));
    expect((await repo.listItemTypes()).find((t) => t.id === LIST_TYPE_ID)!.states.map((st) => st.name)).toEqual(['Backlog', 'En curso', 'Dependencia', 'Completada']);
    expect(await repo.getTask(doing.id)).toMatchObject({ type_id: LIST_TYPE_ID, state_id: 'lista-en-curso' });
    expect((await repo.getTask(other.id))!.type_id).not.toBe(LIST_TYPE_ID);
    // La lista cambia «En curso» por «Revisión» (del mismo grupo): la tarea pasa a ese estado.
    await repo.ensureListType(listItemType(['Backlog', 'Revisión', 'Completada'], { statusColumn: 'Estado', map: { Revisión: 'doing' } }, 50));
    expect((await repo.getTask(doing.id))!.state_id).toBe('lista-revision');
  });
});

describe('Microsoft List: columnas del Tablero con todos los tipos', async () => {
  const { listBoardColumn, listStateForColumn, listItemType } = await import('../src/domain/msList');
  it('cada estado va a su columna y al soltar se elige el estado', () => {
    expect(['Backlog', 'In progres', 'In Progress', 'En curso', 'Dependencia', 'Completada', 'Otra cosa'].map(listBoardColumn))
      .toEqual(['New', 'In-Progress', 'In-Progress', 'In-Progress', 'Need Review', 'Accepted', null]);
    const type = listItemType(['Backlog', 'In progress', 'Dependencia', 'Completada'], { statusColumn: 'Estado', map: {} }, 9);
    const to = (c: string) => listStateForColumn(type, c)?.name;
    expect(['New', 'Defined', 'In-Progress', 'Blocked', 'Need Review', 'Completed', 'Accepted'].map(to))
      .toEqual(['Backlog', 'Backlog', 'In progress', 'Dependencia', 'Dependencia', 'Completada', 'Completada']);
  });
});
