import { describe, expect, it, vi } from 'vitest';
import {
  guessCategory, guessStatusColumn, listMoves, listPushes, statusValues, taskFromListItem, valueForCategory, type MsListConfig,
} from '../src/domain/msList';
import {
  addPending, isSharePointOrigin, parseSnapshot, remainingPending, withPending, type MsListChange, type MsListItem,
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
  const fields = [
    { InternalName: 'Title', Title: 'Title', TypeAsString: 'Text', ReadOnlyField: false },
    { InternalName: 'Estado', Title: 'Estado', TypeAsString: 'Choice', Choices: ['Pendiente', 'En curso', 'Hecho'], ReadOnlyField: false },
    { InternalName: 'Responsable', Title: 'Responsable', TypeAsString: 'User', ReadOnlyField: false },
    { InternalName: 'Fecha_x0020_l_x00ed_mite', Title: 'Fecha límite', TypeAsString: 'DateTime', DisplayFormat: 0, ReadOnlyField: false },
    { InternalName: 'Horas', Title: 'Horas', TypeAsString: 'Number', ReadOnlyField: false },
    { InternalName: 'ContentType', Title: 'Tipo de contenido', TypeAsString: 'Computed', ReadOnlyField: true },
  ];
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith('/_api/contextinfo')) return json({ FormDigestValue: 'digest-1' });
    if (init.method === 'POST' && /\/items\(\d+\)/.test(url)) {
      merges.push({ url, body: JSON.parse(init.body!), headers: init.headers! });
      return new Response(null, { status: 204 });
    }
    if (url.includes('/fields?')) return json({ value: fields });
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
  return { fetch, merges };
}

describe('Microsoft List: el marcador', () => {
  it('abre Marea, aplica los cambios pendientes, lee la lista entera y se la manda', async () => {
    const app = 'https://marea.example';
    const sp = fakeSharePoint();
    const posted: { data: Record<string, unknown>; origin: string }[] = [];
    const popup = { postMessage: (data: Record<string, unknown>, origin: string) => posted.push({ data, origin }) };
    const listeners: ((e: unknown) => void)[] = [];
    const box = { style: {}, textContent: '', id: '', remove() {} };
    const win = {
      open: (url: string, name: string) => { expect([url, name]).toEqual([`${app}/#/lista`, 'marea-lista']); return popup; },
      addEventListener: (_: string, l: (e: unknown) => void) => listeners.push(l),
      removeEventListener: () => {},
    };
    const doc = { getElementById: () => null, createElement: () => box, body: { appendChild: () => {} } };
    const loc = { origin: 'https://wpp.sharepoint.com', pathname: '/sites/equipo/Lists/Contratos/AllItems.aspx' };
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
    expect(sp.merges.map((m) => m.body)).toEqual([{ Estado: 'Hecho' }, { Title: 'Revisar contrato v2' }, { Horas: 2.5 }]);
    expect(sp.merges[0].headers).toMatchObject({ 'X-HTTP-Method': 'MERGE', 'X-RequestDigest': 'digest-1', 'IF-MATCH': '*' });
    expect(sp.merges[0].url).toContain("/sites/equipo/_api/web/GetList(@u)/items(7)?@u='%2Fsites%2Fequipo%2FLists%2FContratos'");
    const sent = posted.find((p) => p.data.type === 'marea-lista:data')!;
    expect(sent.origin).toBe(app);
    expect((sent.data.results as { ok: boolean }[]).map((r) => r.ok)).toEqual([true, true, true, false]);
    const snapshot = parseSnapshot(sent.data.list)!;
    expect(snapshot.title).toBe('Contratos');
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
