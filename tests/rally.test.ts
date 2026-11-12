import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Api } from './fakeAccounts.ts';
import { commentHtml, fieldValue, htmlToText, joinQuery, MOVE_COMMENTS, blockedReasonText, messageHtml, moveComment, normalizeBaseUrl, Rally, rallyCategory, toRallyItem } from '../servidor/rally.ts';
import { groupRally, isRallyId, rallyColumnOf, linkedTask, rallyIdsOf, rallyMoves, rallyPushes, taskFromRally, tasksByRallyId, type RallyItem } from '../src/domain/rally';
import { DEFAULT_ITEM_TYPES } from '../src/domain/workflows';
import { makeTask } from './factories';

const BASE = 'https://eu1.rallydev.com';
const story = { _type: 'HierarchicalRequirement', FormattedID: 'US1764574', ObjectID: 111, Name: ' Login SSO ', ScheduleState: 'In-Progress',
  Blocked: false, Project: { _refObjectName: 'Caixa Web' }, Iteration: { _refObjectName: 'Sprint 14' }, Release: null, LastUpdateDate: '2026-10-20T10:00:00.000Z' };

const item = (extra: Partial<RallyItem> = {}): RallyItem => ({
  id: 'US1', objectId: '1', kind: 'US', name: 'Uno', state: 'Defined', done: false, blocked: false, ready: false, project: null,
  stateOrder: 2, category: 'todo', iteration: null, release: null, assignee: null, owner: null, mine: true, tags: [], updatedAt: '', url: `${BASE}/#/detail/userstory/1`, ...extra,
});

/** Rally falso: responde a /user y a /artifact y apunta las peticiones. */
function fakeRally(results: Record<string, unknown>[], status = 200) {
  const calls: { url: string; key: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: (init.headers as Record<string, string>).ZSESSIONID });
    const body = url.includes('/user') ? { User: { ObjectID: 42, DisplayName: 'Marta García' } }
      : { QueryResult: { Errors: [], Results: results, TotalResultCount: results.length } };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('Rally: servidor', () => {
  it('convierte los resultados de la WSAPI y descarta los tipos que no usamos', () => {
    expect(toRallyItem(story, BASE)).toEqual({
      id: 'US1764574', objectId: '111', kind: 'US', name: 'Login SSO', state: 'In-Progress', stateOrder: 5, category: 'doing', done: false, blocked: false, ready: false,
      project: 'Caixa Web', iteration: 'Sprint 14', release: null, assignee: null, owner: null, mine: false, tags: [], updatedAt: '2026-10-20T10:00:00.000Z',
      url: `${BASE}/#/detail/userstory/111`,
    });
    expect(toRallyItem({ ...story, ScheduleState: 'Accepted' }, BASE)?.done).toBe(true);
    expect(toRallyItem({ _type: 'Defect', FormattedID: 'DE9', ObjectID: 9, ScheduleState: 'Defined', State: 'Closed' }, BASE)?.state).toBe('Defined');
    expect(toRallyItem({ _type: 'TestCase', FormattedID: 'TC5', ObjectID: 5 }, BASE)).toMatchObject({ kind: 'TC', state: 'Sin ejecutar', done: false });
    expect(toRallyItem({ _type: 'TestCase', FormattedID: 'TC6', ObjectID: 6, LastVerdict: 'Pass' }, BASE)?.done).toBe(true);
    expect(toRallyItem({ _type: 'PortfolioItem/Feature', FormattedID: 'F1', ObjectID: 3, State: { _refObjectName: 'Developing', OrderIndex: 3 } }, BASE))
      .toMatchObject({ kind: 'FE', state: 'Developing', stateOrder: 3, category: 'doing', done: false, url: `${BASE}/#/detail/portfolioitem/feature/3` });
    expect(toRallyItem({ _type: 'PortfolioItem/Feature', FormattedID: 'FE2', State: { _refObjectName: 'Done' } }, BASE)).toMatchObject({ category: 'done', done: true });
    expect(toRallyItem({ _type: 'PortfolioItem/Theme', FormattedID: 'T1' }, BASE)).toBeNull();
  });

  it('usa la columna del tablero (FlowState) y el Assignee, y marca lo de la persona conectada', () => {
    const user = (id: number, name: string) => ({ _ref: `${BASE}/slm/webservice/v2.0/user/${id}`, _refObjectName: name });
    const it = toRallyItem({
      ...story, FlowState: { _refObjectName: 'Need Review', OrderIndex: 6 }, ScheduleState: 'Accepted',
      Owner: user(1, 'Albert'), c_Assignee: user(42, 'Marc'),
    }, BASE, '42');
    expect(it).toMatchObject({ state: 'Need Review', stateOrder: 6, done: true, assignee: 'Marc', owner: 'Albert', mine: true });
    expect(toRallyItem({ ...story, Owner: user(1, 'Albert') }, BASE, '42')).toMatchObject({ assignee: 'Albert', mine: false });
  });

  it('clasifica en Por hacer, Bloqueado, En curso, Hecho y Accepted', () => {
    expect(rallyCategory('New', 'New', false)).toBe('todo');
    expect(rallyCategory('Defined', 'Defined', false)).toBe('todo');
    expect(rallyCategory('Blocked', 'Defined', false)).toBe('blocked');
    // Con columna manda la columna: la marca Blocked no cambia de bloque. Sin columna (tareas), sí cuenta.
    expect(rallyCategory('Need Review', 'In-Progress', true)).toBe('doing');
    expect(rallyCategory(null, 'In-Progress', true)).toBe('blocked');
    expect(rallyCategory('Need Review', 'In-Progress', false)).toBe('doing');
    expect(rallyCategory('Desarrollo', 'Defined', false)).toBe('doing');
    expect(rallyCategory('Completed', 'Completed', false)).toBe('done');
    expect(rallyCategory('Accepted', 'Accepted', true)).toBe('accepted');
    expect(rallyCategory(null, 'Closed', false)).toBe('accepted');
    expect(rallyCategory(null, 'Pass', false)).toBe('done');
    expect(rallyCategory(null, 'Fail', false)).toBe('blocked');
    expect(rallyCategory(null, 'Sin ejecutar', false)).toBe('todo');
  });

  it('anida las condiciones de dos en dos, como pide la WSAPI', () => {
    expect(joinQuery(['(a)'], 'OR')).toBe('(a)');
    expect(joinQuery(['(a)', '(b)', '(c)'], 'OR')).toBe('(((a) OR (b)) OR (c))');
  });

  it('solo admite direcciones de Rally', () => {
    expect(normalizeBaseUrl('')).toBe(BASE);
    expect(normalizeBaseUrl('rally1.rallydev.com/slm')).toBe('https://rally1.rallydev.com');
    expect(() => normalizeBaseUrl('https://evil.example.com')).toThrow(/Rally/);
    expect(() => normalizeBaseUrl('http://eu1.rallydev.com')).toThrow(/Rally/);
  });

  it('comprueba la clave, la guarda por usuario sin devolverla y consulta lo asignado', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const { fetcher, calls } = fakeRally([story, { _type: 'Milestone', FormattedID: 'MI1' }]);
    const rally = new Rally(db, fetcher);

    await expect(rally.items(marta)).rejects.toThrow(/Conecta/);
    await expect(rally.connect(marta, { apiKey: '  ' })).rejects.toThrow(/clave/);
    const status = await rally.connect(marta, { apiKey: '_secreta1234' });
    expect(status).toEqual({ connected: true, baseUrl: BASE, keyHint: '1234', rallyUser: 'Marta García' });
    expect(JSON.stringify(status)).not.toContain('_secreta');

    calls.length = 0;
    const items = await rally.items(marta, 30);
    expect(items.map((i) => i.id)).toEqual(Array(7).fill('US1764574')); // el Rally falso responde lo mismo a cada tipo
    expect(calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['feature', 'hierarchicalrequirement', 'defect', 'defectsuite', 'task', 'testset', 'testcase']);
    expect(calls[0].key).toBe('_secreta1234');
    const query = (i: number) => new URL(calls[i].url).searchParams.get('query');
    expect(query(0)).toMatch(/^\(\(Owner\.ObjectID = 42\) AND /); // features: solo Owner
    expect(query(1)).toMatch(/^\(\(\(Owner\.ObjectID = 42\) OR \(c_Assignee\.ObjectID = 42\)\) AND \(LastUpdateDate >= "\d{4}-\d{2}-\d{2}"\)\)$/);
    expect(query(5)).toMatch(/^\(\(Owner\.ObjectID = 42\) AND /);

    calls.length = 0;
    await rally.items(marta, 0);
    expect(query(1)).toBe('((Owner.ObjectID = 42) OR (c_Assignee.ObjectID = 42))');

    calls.length = 0;
    await rally.items(marta, 0, ['7', '8', 'mal']);
    expect(query(0)).toBe('((Project.ObjectID = 7) OR (Project.ObjectID = 8))');
    expect(query(4)).toBe('((Project.ObjectID = 7) OR (Project.ObjectID = 8))');

    calls.length = 0;
    await rally.lookup(marta, { ids: ['us-1', 'US1', 'TS9', 'mal', 'DE"x'] });
    expect(calls.map((c) => `${new URL(c.url).pathname.split('/').pop()} ${new URL(c.url).searchParams.get('query')}`)).toEqual([
      'hierarchicalrequirement (FormattedID = "US1")', 'testset (FormattedID = "TS9")',
    ]);

    expect((await rally.disconnect(marta)).connected).toBe(false);
  });

  it('explica una clave rechazada', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const rally = new Rally(db, fakeRally([], 401).fetcher);
    await expect(rally.connect(marta, { apiKey: '_mala' })).rejects.toThrow(/no acepta la clave/);
    expect((await rally.status(marta)).connected).toBe(false);
  });
});

describe('Rally: ficha', () => {
  it('pasa el HTML de Rally a texto legible', () => {
    expect(htmlToText('<p>Hola&nbsp;<b>equipo</b></p><ul><li>Uno</li><li>Dos &amp; tres</li></ul><p>Fin<br>línea &#8364; &#x41;</p>'))
      .toBe('Hola equipo\n\n• Uno\n• Dos & tres\nFin\nlínea € A');
    expect(htmlToText('<script>alert(1)</script><div>ok</div><img src="x">')).toBe('ok\n[imagen]');
  });

  it('da formato a los valores y descarta los vacíos y las colecciones', () => {
    expect(fieldValue('2026-10-20T10:30:00.000Z')).toBe('2026-10-20 10:30');
    expect(fieldValue({ _refObjectName: 'Sprint 14' })).toBe('Sprint 14');
    expect(fieldValue(true)).toBe('Sí');
    expect(fieldValue(3)).toBe('3');
    for (const v of [null, '', false, 0, { Count: 2, _ref: 'x' }]) expect(fieldValue(v)).toBeNull();
  });

  it('monta la ficha con los nombres de Rally, textos, etiquetas, hijos, discusión y adjuntos', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const ws = `${BASE}/slm/webservice/v2.0`;
    const col = (path: string, count: number) => ({ _ref: `${ws}/HierarchicalRequirement/111/${path}`, Count: count });
    const responses: Record<string, unknown> = {
      '/user': { User: { ObjectID: 42, DisplayName: 'Marta' } },
      '/hierarchicalrequirement/111': { HierarchicalRequirement: {
        ...story, ObjectUUID: 'x', Blocked: true, BlockedReason: 'Falta figma', c_APPGAR: 'APP1', PlanEstimate: 0,
        Description: '<p>Como usuaria quiero <b>entrar</b></p>', Notes: '', c_Criterios: '<ul><li>Funciona</li></ul>',
        Tags: col('Tags', 1), Discussion: col('Discussion', 1), Attachments: col('Attachments', 1), Tasks: col('Tasks', 1),
        Children: col('Children', 0), TestCases: col('TestCases', 0), Defects: col('Defects', 0),
      } },
      '/typedefinition': { QueryResult: { Errors: [], Results: [{ Attributes: { _ref: `${ws}/TypeDefinition/1/Attributes` } }] } },
      '/TypeDefinition/1/Attributes': { QueryResult: { Errors: [], Results: [
        { ElementName: 'c_APPGAR', Name: 'APPGAR' }, { ElementName: 'c_Criterios', Name: 'Criterios de aceptación' },
        { ElementName: 'Description', Name: 'Description' }, { ElementName: 'ScheduleState', Name: 'Schedule State' },
      ] } },
      '/HierarchicalRequirement/111/Tags': { QueryResult: { Errors: [], Results: [{ Name: 'APP' }] } },
      '/HierarchicalRequirement/111/Discussion': { QueryResult: { Errors: [], Results: [
        { Text: '<p>¿Hay diseño?</p>', User: { _refObjectName: 'Ana' }, CreationDate: '2026-10-21T09:00:00.000Z' },
      ] } },
      '/HierarchicalRequirement/111/Attachments': { QueryResult: { Errors: [], Results: [{ Name: 'login.png', Size: 2048 }] } },
      '/HierarchicalRequirement/111/Tasks': { QueryResult: { Errors: [], Results: [
        { _type: 'Task', FormattedID: 'TA1', ObjectID: 5, Name: 'Maquetar', State: 'Defined' },
      ] } },
    };
    const fetcher = (async (url: string) => {
      const path = new URL(url).pathname.replace('/slm/webservice/v2.0', '');
      return new Response(JSON.stringify(responses[path] ?? { QueryResult: { Errors: [`No existe ${path}`] } }));
    }) as unknown as typeof fetch;
    const rally = new Rally(db, fetcher);
    await rally.connect(marta, { apiKey: '_clave' });

    await expect(rally.detail(marta, 'XX', '111')).rejects.toThrow(/no válido/);
    await expect(rally.detail(marta, 'US', '1;drop')).rejects.toThrow(/no válido/);
    const d = await rally.detail(marta, 'US', '111');
    expect(d.item).toMatchObject({ id: 'US1764574', blocked: true });
    expect(d.blockedReason).toBe('Falta figma');
    expect(d.fields).toContainEqual({ label: 'APPGAR', value: 'APP1' });
    expect(d.fields).toContainEqual({ label: 'Schedule State', value: 'In-Progress' });
    expect(d.fields.map((f) => f.label)).not.toContain('ObjectUUID');
    expect(d.fields.map((f) => f.label)).not.toContain('PlanEstimate');
    expect(d.texts).toEqual([
      { label: 'Description', text: 'Como usuaria quiero entrar' },
      { label: 'Criterios de aceptación', text: '• Funciona' },
    ]);
    expect(d.tags).toEqual(['APP']);
    expect(d.related).toEqual([{ label: 'Tareas', items: [expect.objectContaining({ id: 'TA1', kind: 'TA', state: 'Defined' })] }]);
    expect(d.discussion).toEqual([{ author: 'Ana', date: '2026-10-21T09:00:00.000Z', text: '¿Hay diseño?' }]);
    expect(d.attachments).toEqual([{ name: 'login.png', size: 2048 }]);
  });
});

const pushIds = (p: { id: string; category: string }[]) => p.map(({ id, category }) => ({ id, category }));

describe('Rally: mover', () => {
  const ws = `${BASE}/slm/webservice/v2.0`;
  const flows = ['New', 'Defined', 'To Do', 'Blocked', 'In-Progress', 'Need Review', 'Completed', 'Accepted']
    .map((Name, i) => ({ Name, _ref: `${ws}/flowstate/${i + 1}` }));

  async function setup(row: Record<string, unknown>, opts: { readOnly?: boolean; noAssignee?: boolean } = {}) {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const posts: { path: string; body: unknown }[] = [];
    const gets: URL[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace('/slm/webservice/v2.0', '');
      if (init.method !== 'POST') gets.push(u);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ path, body });
        if (opts.readOnly) return new Response(JSON.stringify({ OperationResult: { Errors: ['Not authorized to perform action: Invalid key'] } }));
        const patch = Object.values(body)[0] as Record<string, unknown>;
        if (opts.noAssignee && 'c_Assignee' in patch) return new Response(JSON.stringify({ CreateResult: { Errors: ['Could not set value for c_Assignee'] } }));
        const flow = flows.find((f) => f._ref === patch.FlowState);
        return new Response(JSON.stringify({ OperationResult: { Errors: [], Object: { ...row, ...patch, ...(flow ? { FlowState: { _refObjectName: flow.Name } } : {}) } } }));
      }
      // Buscar un usuario por ObjectID (para su ObjectUUID); sin consulta, es la comprobación de la clave.
      const results = path === '/user'
        ? (u.searchParams.has('query') ? [{ _refObjectUUID: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' }] : null)
        : path === '/flowstate' ? flows : [row];
      return new Response(JSON.stringify(results ? { QueryResult: { Errors: [], Results: results, TotalResultCount: results.length } } : { User: { ObjectID: 42, DisplayName: 'Marta' } }));
    }) as unknown as typeof fetch;
    const rally = new Rally(db, fetcher);
    await rally.connect(marta, { apiKey: '_clave' });
    gets.length = 0;
    return { rally, marta, posts, gets };
  }
  const us = { FormattedID: 'US1', ObjectID: 111, Name: 'Login', ScheduleState: 'In-Progress', FlowState: { _refObjectName: 'Need Review' },
    Blocked: true, Project: { _ref: `${ws}/project/7` } };

  it('mueve a la columna del tablero de la categoría y quita la marca de bloqueo', async () => {
    const { rally, marta, posts } = await setup(us);
    const item = await rally.move(marta, { id: 'US-1', category: 'accepted' });
    expect(posts).toEqual([{ path: '/hierarchicalrequirement/111', body: { HierarchicalRequirement: { FlowState: `${ws}/flowstate/8`, Blocked: false } } }]);
    expect(item.category).toBe('accepted');
    posts.length = 0;
    await rally.move(marta, { id: 'US1', category: 'todo' });
    expect(posts[0].body).toEqual({ HierarchicalRequirement: { FlowState: `${ws}/flowstate/2`, Blocked: false } }); // Defined, no New
  });

  it('al mover propone el comentario y lo publica con el PO y el analista', async () => {
    const comments = (p: { path: string; body: unknown }[]) => p.filter((x) => x.path === '/conversationpost/create')
      .map((x) => (x.body as { ConversationPost: { Artifact: string; Text: string } }).ConversationPost);
    const owner = { _ref: `${ws}/user/55`, _refObjectName: 'Pepa PO', _refObjectUUID: '2a75bf52-cfd9-4550-97ec-fc6383373083' };
    const nueva = await setup({ ...us, ScheduleState: 'Defined', FlowState: { _refObjectName: 'New' }, Blocked: false, Owner: owner });
    const item = await nueva.rally.move(nueva.marta, { id: 'US1', category: 'todo' });
    expect(nueva.posts).toEqual([{ path: '/hierarchicalrequirement/111', body: { HierarchicalRequirement: { FlowState: `${ws}/flowstate/2` } } }]); // New → Defined, sin comentar aún
    expect(item.comment).toBe(MOVE_COMMENTS.defined);

    const r = await nueva.rally.moveCommentPost(nueva.marta, { id: 'US-1', text: item.comment, analyst: { ref: '/user/77', name: 'Luis <QA>' } });
    expect(r).toEqual({ text: MOVE_COMMENTS.defined, owner: 'Pepa PO', analyst: 'Luis <QA>' });
    expect(comments(nueva.posts)).toEqual([{
      Artifact: '/hierarchicalrequirement/111',
      // Como el editor de Rally: <span class="mention" data-mention="ObjectUUID">, que es lo que hace que avise por correo.
      Text: `<p><span class="mention" data-mention="2a75bf52-cfd9-4550-97ec-fc6383373083">@Pepa PO</span> Guía definida correctamente<br />Analista: <span class="mention" data-mention="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">@Luis &lt;QA&gt;</span></p>`,
    }]);
    // Sin analista: solo el PO.
    await nueva.rally.moveCommentPost(nueva.marta, { id: 'US1', text: MOVE_COMMENTS.blocked, analyst: null });
    expect(comments(nueva.posts)[1].Text).toBe(`<p><span class="mention" data-mention="2a75bf52-cfd9-4550-97ec-fc6383373083">@Pepa PO</span> Guía bloqueada</p>`);
    // Texto modificado con el lápiz (con saltos de línea); vacío no.
    await nueva.rally.moveCommentPost(nueva.marta, { id: 'US1', text: 'Guía bloqueada\nfalta el diseño', analyst: null });
    expect(comments(nueva.posts)[2].Text).toBe(`<p><span class="mention" data-mention="2a75bf52-cfd9-4550-97ec-fc6383373083">@Pepa PO</span> Guía bloqueada<br />falta el diseño</p>`);
    await expect(nueva.rally.moveCommentPost(nueva.marta, { id: 'US1', text: '  ' })).rejects.toThrow(/no válido/);
    await expect(nueva.rally.moveCommentPost(nueva.marta, { id: 'US1', text: MOVE_COMMENTS.done, analyst: { ref: 'http://x', name: 'a' } })).rejects.toThrow(/Analista/);

    for (const category of ['doing', 'blocked', 'done', 'accepted']) {
      const moved = await nueva.rally.move(nueva.marta, { id: 'US1', category });
      expect(moved.comment).toBe(category === 'accepted' ? undefined : MOVE_COMMENTS[category as 'doing']);
    }
  });

  it('con dryRun no escribe y dice qué comentario tocaría', async () => {
    const { rally, marta, posts } = await setup({ ...us, ScheduleState: 'Defined', FlowState: { _refObjectName: 'New' }, Blocked: false });
    const doing = await rally.move(marta, { id: 'US1', category: 'doing', dryRun: true });
    expect(doing).toMatchObject({ state: 'In-Progress', category: 'doing', comment: MOVE_COMMENTS.doing });
    const defined = await rally.move(marta, { id: 'US1', category: 'todo', dryRun: true });
    expect(defined).toMatchObject({ state: 'Defined', comment: MOVE_COMMENTS.defined });
    expect((await rally.move(marta, { id: 'US1', category: 'accepted', dryRun: true })).comment).toBeUndefined();
    expect(posts).toEqual([]);
  });

  it('rallyPushes dice la tarea y el estado del que venía', () => {
    const before = makeTask({ id: 't1', external_id: 'US9', type_id: 'us', state_id: 'us-dev' });
    expect(rallyPushes([{ table: 'tasks', before, after: { ...before, state_id: 'us-blocked' } }], false, DEFAULT_ITEM_TYPES))
      .toEqual([{ id: 'US9', category: 'blocked', taskId: 't1', fromStateId: 'us-dev' }]);
  });

  it('elige el comentario según el paso', () => {
    const at = (state: string, category: RallyItem['category']) => ({ state, category });
    expect(moveComment(at('New', 'todo'), at('Defined', 'todo'))).toBe(MOVE_COMMENTS.defined);
    expect(moveComment(at('In-Progress', 'doing'), at('Defined', 'todo'))).toBeNull(); // volver atrás
    expect(moveComment(at('Defined', 'todo'), at('In-Progress', 'doing'))).toBe(MOVE_COMMENTS.doing);
    expect(moveComment(at('In-Progress', 'doing'), at('Need Review', 'doing'))).toBeNull();
    expect(moveComment(at('In-Progress', 'doing'), at('Blocked', 'blocked'))).toBe(MOVE_COMMENTS.blocked);
    expect(moveComment(at('In-Progress', 'doing'), at('Completed', 'done'))).toBe(MOVE_COMMENTS.done);
    expect(moveComment(at('Completed', 'done'), at('Accepted', 'accepted'))).toBeNull();
  });

  it('no escribe si ya está en esa categoría; las tareas cambian su State', async () => {
    const { rally, marta, posts } = await setup({ ...us, Blocked: false });
    await rally.move(marta, { id: 'US1', category: 'doing' }); // Need Review ya es "En curso"
    expect(posts).toEqual([]);
    const task = await setup({ FormattedID: 'TA5', ObjectID: 5, State: 'Defined', Blocked: false });
    await task.rally.move(task.marta, { id: 'TA5', category: 'accepted' });
    expect(task.posts[0]).toEqual({ path: '/task/5', body: { Task: { State: 'Completed' } } });
    await task.rally.move(task.marta, { id: 'TA5', category: 'blocked' });
    expect(task.posts[1].body).toEqual({ Task: { Blocked: true } });
  });

  it('al bloquear marca Blocked y pone el comentario (sin personas) como motivo', async () => {
    const { rally, marta, posts } = await setup({ ...us, ScheduleState: 'In-Progress', FlowState: { _refObjectName: 'In-Progress' }, Blocked: false });
    const preview = await rally.move(marta, { id: 'US1', category: 'blocked', dryRun: true, blockedReason: 'x' });
    expect(preview).toMatchObject({ category: 'blocked', blocked: true, comment: MOVE_COMMENTS.blocked });
    expect(posts).toEqual([]);
    await rally.move(marta, { id: 'US1', category: 'blocked', blockedReason: 'Guía bloqueada\n  falta el diseño ' });
    const patch = (posts[0].body as { HierarchicalRequirement: Record<string, unknown> }).HierarchicalRequirement;
    // Aunque haya columna Blocked, el botón Blocked también se marca.
    expect(patch).toMatchObject({ Blocked: true, BlockedReason: 'Guía bloqueada falta el diseño' });
    expect(blockedReasonText('a'.repeat(300))).toHaveLength(256);
    expect(blockedReasonText('   ')).toBeNull();
  });

  it('publica el mensaje de Ready con las personas de Rally etiquetadas', async () => {
    const ana = { name: 'Ana', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const anaMaria = { name: 'Ana María', uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const span = (m: { name: string; uuid: string }) => `<span class="mention" data-mention="${m.uuid}">@${m.name}</span>`;
    expect(messageHtml('Hola @Ana María y @Ana,\nok <b>', [ana, anaMaria]))
      .toBe(`<p>Hola ${span(anaMaria)} y ${span(ana)},<br />ok &lt;b&gt;</p>`);

    const { rally, marta, posts } = await setup(us);
    const r = await rally.messagePost(marta, { id: 'US1', text: 'Hola @Luis QA, lista', mentions: [
      { ref: '/user/77', name: 'Luis QA' }, { ref: '/user/78', name: 'Borrada' }] });
    expect(r).toEqual({ mentioned: ['Luis QA'] }); // la que ya no sale en el texto no se menciona
    expect(posts).toEqual([{ path: '/conversationpost/create', body: { ConversationPost: { Artifact: '/hierarchicalrequirement/111',
      Text: '<p>Hola <span class="mention" data-mention="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb">@Luis QA</span>, lista</p>' } } }]);
    await expect(rally.messagePost(marta, { id: 'US1', text: ' ' })).rejects.toThrow(/no válido/);
    await expect(rally.messagePost(marta, { id: 'US1', text: 'x', mentions: [{ ref: 'http://x', name: 'a' }] })).rejects.toThrow(/Persona/);
  });

  it('mueve a una columna concreta (Tablero «Como en Rally»)', async () => {
    const { rally, marta, posts } = await setup({ ...us, FlowState: { _refObjectName: 'In-Progress' }, Blocked: false });
    const preview = await rally.move(marta, { id: 'US1', category: 'doing', flow: 'Need Review', dryRun: true });
    expect(preview).toMatchObject({ state: 'Need Review', category: 'doing' });
    expect(preview.comment).toBeUndefined(); // dentro de En curso no se comenta
    await rally.move(marta, { id: 'US1', category: 'doing', flow: 'need-review' });
    expect(posts[0].body).toEqual({ HierarchicalRequirement: { FlowState: `${ws}/flowstate/6` } });
    posts.length = 0;
    await rally.move(marta, { id: 'US1', category: 'doing', flow: 'In-Progress' }); // ya está ahí
    expect(posts).toEqual([]);
  });

  it('lleva un TS a Need Review con Blocked, motivo y comentario a la vez; todo obligatorio', async () => {
    const owner = { _ref: `${ws}/user/55`, _refObjectName: 'Pepa PO', _refObjectUUID: '2a75bf52-cfd9-4550-97ec-fc6383373083' };
    const ts = { FormattedID: 'TS9', ObjectID: 999, Name: 'Pruebas login', ScheduleState: 'In-Progress', FlowState: { _refObjectName: 'In-Progress' },
      Blocked: false, Owner: owner, Project: { _ref: `${ws}/project/7` } };
    const { rally, marta, posts } = await setup(ts);
    const analyst = { ref: '/user/77', name: 'Luis QA' };
    const ok = { id: 'TS9', defectId: 'DE12', text: 'se abre defect https://eu1.rallydev.com/#/detail/defect/5 por errores', analyst, reason: 'Esperando\nal DE12' };
    for (const bad of [{ id: 'US1' }, { defectId: '' }, { text: ' ' }, { analyst: null }, { reason: '' }]) {
      await expect(rally.needReview(marta, { ...ok, ...bad })).rejects.toThrow();
    }
    expect(posts).toEqual([]);
    const r = await rally.needReview(marta, ok);
    expect(posts[0]).toEqual({ path: '/testset/999', body: { TestSet: { FlowState: `${ws}/flowstate/6`, Blocked: true, BlockedReason: 'Esperando al DE12' } } });
    expect(r.item).toMatchObject({ state: 'Need Review', category: 'doing', blocked: true });
    const text = (posts[1].body as { ConversationPost: { Text: string } }).ConversationPost.Text;
    expect(text).toContain('data-mention="2a75bf52-cfd9-4550-97ec-fc6383373083">@Pepa PO</span> se abre defect <a href="https://eu1.rallydev.com/#/detail/defect/5"');
    expect(text).toContain('Analista: <span class="mention"');
    expect(text).not.toContain('Esperando'); // el motivo no va a la discusión
    expect(r).toMatchObject({ owner: 'Pepa PO', analyst: 'Luis QA' });
  });

  it('coloca cada tarjeta en su columna de Rally o en la de su grupo', () => {
    expect(rallyColumnOf('Need Review', 'doing')).toBe('Need Review');
    expect(rallyColumnOf('In Progress', 'doing')).toBe('In-Progress');
    expect(rallyColumnOf('Columna rara', 'doing')).toBe('In-Progress');
    expect(rallyColumnOf(undefined, 'todo')).toBe('New');
    // To Do y Desarrollo no tienen columna: van a la de su grupo.
    expect(rallyColumnOf('To Do', 'todo')).toBe('New');
    expect(rallyColumnOf('Desarrollo', 'doing')).toBe('In-Progress');
    expect(rallyColumnOf(undefined, 'accepted')).toBe('Accepted');
    // Las que no están en Rally: la columna en la que se soltaron (si existe); el estado de Rally manda siempre.
    expect(rallyColumnOf(undefined, 'todo', 'Defined')).toBe('Defined');
    expect(rallyColumnOf(undefined, 'doing', 'Need Review')).toBe('Need Review');
    expect(rallyColumnOf(undefined, 'todo', 'Inventada')).toBe('New');
    expect(rallyColumnOf('Completed', 'done', 'Defined')).toBe('Completed');
  });

  it('Ready y Blocked se marcan sin cambiar de columna', async () => {
    const { rally, marta, posts } = await setup({ ...us, FlowState: { _refObjectName: 'In-Progress' }, Blocked: false });
    const ready = await rally.flag(marta, { id: 'US-1', ready: true });
    expect(posts[0]).toEqual({ path: '/hierarchicalrequirement/111', body: { HierarchicalRequirement: { Ready: true } } });
    expect(ready).toMatchObject({ ready: true, category: 'doing' });
    const blocked = await rally.flag(marta, { id: 'US1', blocked: true, reason: 'Guía bloqueada\nfalta el diseño' });
    expect(posts[1].body).toEqual({ HierarchicalRequirement: { Blocked: true, BlockedReason: 'Guía bloqueada falta el diseño' } });
    // Sigue en su bloque: con columna, la marca no la pasa a Bloqueado.
    expect(blocked).toMatchObject({ blocked: true, category: 'doing', state: 'In-Progress' });
    await rally.flag(marta, { id: 'US1', blocked: false });
    expect(posts[2].body).toEqual({ HierarchicalRequirement: { Blocked: false, BlockedReason: '' } });
    await expect(rally.flag(marta, { id: 'US1' })).rejects.toThrow(/Nada/);
    await expect(rally.flag(marta, { id: 'TC1', ready: true })).rejects.toThrow(/no tiene/);
  });

  it('publica un comentario en la discusión', async () => {
    const { rally, marta, posts } = await setup(us);
    expect(commentHtml('  a < b & "c"\nlínea 2 ')).toBe('a &lt; b &amp; &quot;c&quot;<br />línea 2');
    // Los enlaces se pueden pulsar en Rally (sin coger el punto final ni el paréntesis).
    expect(commentHtml('Guía: https://x.sharepoint.com/a?b=1&c=2.\n(ver www.rally.com)'))
      .toBe('Guía: <a href="https://x.sharepoint.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://x.sharepoint.com/a?b=1&amp;c=2</a>.'
        + '<br />(ver <a href="https://www.rally.com" target="_blank" rel="noopener noreferrer">www.rally.com</a>)');
    const post = await rally.comment(marta, { kind: 'US', objectId: '111', text: 'Hola\nqué tal' });
    expect(posts).toEqual([{ path: '/conversationpost/create', body: { ConversationPost: { Artifact: '/hierarchicalrequirement/111', Text: 'Hola<br />qué tal' } } }]);
    expect(post).toMatchObject({ author: 'Marta', text: 'Hola\nqué tal' });
    await expect(rally.comment(marta, { kind: 'US', objectId: '111', text: '  ' })).rejects.toThrow(/Escribe/);
    await expect(rally.comment(marta, { kind: 'XX', objectId: '111', text: 'x' })).rejects.toThrow(/no válido/);
  });

  it('adjunta un archivo en dos pasos (contenido y adjunto)', async () => {
    const { rally, marta, posts } = await setup({ _ref: `${ws}/attachmentcontent/900` });
    const content = Buffer.from('hola').toString('base64');
    const file = await rally.attach(marta, { kind: 'DE', objectId: '5', name: 'C:\\captura.png', contentType: 'image/png', content });
    expect(posts).toEqual([
      { path: '/attachmentcontent/create', body: { AttachmentContent: { Content: content } } },
      { path: '/attachment/create', body: { Attachment: { Artifact: '/defect/5', Content: '/attachmentcontent/900', ContentType: 'image/png', Name: 'captura.png', Size: 4 } } },
    ]);
    expect(file).toEqual({ name: 'captura.png', size: 4 });
    await expect(rally.attach(marta, { kind: 'DE', objectId: '5', name: 'x', content: '!!' })).rejects.toThrow(/no válido/);
  });

  it('crea User Stories en un proyecto y tareas dentro de su US, con Owner y Assignee', async () => {
    const { rally, marta, posts } = await setup(us);
    const item = await rally.create(marta, { kind: 'US', name: '  Nuevo   login ', description: 'a < b', projectId: '7', assignToMe: true });
    expect(posts).toEqual([{ path: '/hierarchicalrequirement/create', body: { HierarchicalRequirement: {
      Name: 'Nuevo login', Owner: '/user/42', Description: 'a &lt; b', Project: '/project/7', c_Assignee: '/user/42' } } }]);
    expect(item).toMatchObject({ id: 'US1', kind: 'US', name: 'Nuevo login' });
    posts.length = 0;
    await rally.create(marta, { kind: 'TA', name: 'Probar', parentId: 'US-1', assignToMe: false });
    expect(posts).toEqual([{ path: '/task/create', body: { Task: { Name: 'Probar', Owner: '/user/42', WorkProduct: '/hierarchicalrequirement/111', Project: '/project/7' } } }]);
  });

  it('crea sin Assignee si Rally no tiene ese campo y valida lo que falta', async () => {
    const { rally, marta, posts } = await setup(us, { noAssignee: true });
    await rally.create(marta, { kind: 'DE', name: 'Falla', projectId: '7', assignToMe: true });
    expect(posts.map((p) => 'c_Assignee' in (Object.values(p.body as object)[0] as object))).toEqual([true, false]);
    await expect(rally.create(marta, { kind: 'US', name: 'x' })).rejects.toThrow(/proyecto/);
    await expect(rally.create(marta, { kind: 'TA', name: 'x', parentId: 'TC1' })).rejects.toThrow(/User Story o un defecto/);
    await expect(rally.create(marta, { kind: 'US', name: ' ', projectId: '7' })).rejects.toThrow(/nombre/);
    await expect(rally.create(marta, { kind: 'TC', name: 'x', projectId: '7' })).rejects.toThrow(/test sets y tareas/);
  });

  it('crea con los campos del formulario de Rally (columna, release, etiquetas, padre, feature y personalizados)', async () => {
    const { rally, marta, posts } = await setup(us);
    await rally.create(marta, {
      kind: 'US', name: 'Alta', projectId: '7', ownerRef: '/user/5', assigneeRef: '/user/6', color: '#105CAB', ready: true,
      blocked: true, blockedReason: 'Falta API', scheduleState: 'Defined', flowStateRef: '/flowstate/2', planEstimate: 3, expedite: true,
      releaseRef: '/release/9', iterationRef: '/iteration/4', tagRefs: ['/tag/1'], milestoneRefs: ['/milestone/2'], notes: 'n',
      parentId: 'US1', featureId: 'F1', custom: { c_Canal: 'Web' },
    });
    expect(posts).toEqual([{ path: '/hierarchicalrequirement/create', body: { HierarchicalRequirement: {
      Name: 'Alta', Owner: '/user/5', Notes: 'n', Ready: true, Blocked: true, BlockedReason: 'Falta API', DisplayColor: '#105cab',
      Tags: [{ _ref: '/tag/1' }], Milestones: [{ _ref: '/milestone/2' }], Release: '/release/9', Iteration: '/iteration/4',
      FlowState: '/flowstate/2', PlanEstimate: 3, Expedite: true, Parent: '/hierarchicalrequirement/111',
      PortfolioItem: '/portfolioitem/feature/111', Project: '/project/7', c_Canal: 'Web', c_Assignee: '/user/6' } } }]);
    posts.length = 0;
    await rally.create(marta, { kind: 'TA', name: 'T', parentId: 'DE1', state: 'In-Progress', estimate: 2, toDo: 1 });
    expect(posts[0].body).toEqual({ Task: { Name: 'T', Owner: '/user/42', WorkProduct: '/defect/111', State: 'In-Progress', Estimate: 2, ToDo: 1, Project: '/project/7' } });
    await expect(rally.create(marta, { kind: 'US', name: 'x', projectId: '7', releaseRef: '/project/1' })).rejects.toThrow(/no válido/);
    await expect(rally.create(marta, { kind: 'US', name: 'x', projectId: '7', custom: { Canal: 'x' } })).rejects.toThrow(/personalizado/);
    await expect(rally.create(marta, { kind: 'DS', name: 'Suite', projectId: '7' })).resolves.toMatchObject({ kind: 'DS' });
  });

  it('busca personas, padres y etiquetas en Rally con consultas seguras', async () => {
    const { rally, marta, gets } = await setup(us);
    expect(await rally.searchUsers(marta, 'a')).toEqual([]);
    expect(gets).toEqual([]);
    await rally.searchUsers(marta, 'Marc "x"');
    expect(gets[0].pathname).toMatch(/\/user$/);
    expect(gets[0].searchParams.get('query')).toBe(
      '((((DisplayName contains "Marc x") OR (UserName contains "Marc x")) OR (EmailAddress contains "Marc x")) AND (Disabled = false))');

    gets.length = 0;
    const found = await rally.searchArtifacts(marta, { types: 'US,DE,otro', q: 'us-19', project: '7', release: '9', page: '2' });
    expect(gets[0].pathname).toMatch(/\/artifact$/);
    expect(Object.fromEntries(gets[0].searchParams)).toMatchObject({
      types: 'hierarchicalrequirement,defect', start: '51', pagesize: '50', order: 'CreationDate DESC',
      query: '(((FormattedID = "US19") AND (Project.ObjectID = 7)) AND (Release.ObjectID = 9))',
    });
    expect(found).toEqual({ items: [{ id: 'US1', name: 'Login', project: null }], total: 1 });
    gets.length = 0;
    await rally.searchArtifacts(marta, { types: 'F', q: 'pagos bizum' });
    expect(gets[0].searchParams.get('query')).toBe('(Name contains "pagos bizum")');
    expect(gets[0].searchParams.get('types')).toBe('portfolioitem/feature');
    await expect(rally.searchArtifacts(marta, { types: 'TC' })).rejects.toThrow(/Tipo/);

    gets.length = 0;
    await rally.searchTags(marta, { q: 'ios', page: '1' });
    expect(gets[0].searchParams.get('query')).toBe('((Archived = false) AND (Name contains "ios"))');
  });

  it('lee las etiquetas y filtra por etiqueta, en los proyectos elegidos o en todo Rally', async () => {
    const { rally, marta, gets } = await setup({ ...us, Tags: { Count: 2, _tagsNameArray: [{ Name: 'QA Marc' }, { Name: ' iOS ' }] } });
    const items = await rally.items(marta, 0, [], ['QA Marc', 'i"OS']);
    expect(items[0].tags).toEqual(['QA Marc', 'iOS']);
    expect(gets[0].searchParams.get('fetch')).toContain('Tags');
    expect(gets[0].searchParams.get('query')).toBe('((Tags.Name = "QA Marc") OR (Tags.Name = "i OS"))');
    gets.length = 0;
    await rally.items(marta, 0, ['7'], ['QA Marc']);
    expect(gets[0].searchParams.get('query')).toBe('((Project.ObjectID = 7) AND (Tags.Name = "QA Marc"))');
  });

  it('trae todos los proyectos abiertos, de 200 en 200', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const starts: string[] = [];
    const fetcher = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/user')) return new Response(JSON.stringify({ User: { ObjectID: 42, DisplayName: 'Marta' } }));
      const start = Number(u.searchParams.get('start'));
      starts.push(String(start));
      const count = start === 1 ? 200 : 30;
      const Results = Array.from({ length: count }, (_, i) => ({ ObjectID: start + i, Name: `P${start + i}` }));
      return new Response(JSON.stringify({ QueryResult: { Errors: [], Results, TotalResultCount: 230 } }));
    }) as unknown as typeof fetch;
    const rally = new Rally(db, fetcher);
    await rally.connect(marta, { apiKey: '_clave' });
    const projects = await rally.projects(marta);
    expect(projects).toHaveLength(230);
    expect(starts).toEqual(['1', '201']);
  });

  it('trae hasta 5.000 por tipo (páginas en paralelo) y avisa de lo que no cabe', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const starts: number[] = [];
    const fetcher = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/user')) return new Response(JSON.stringify({ User: { ObjectID: 42, DisplayName: 'Marta' } }));
      const start = Number(u.searchParams.get('start'));
      const isUs = u.pathname.endsWith('/hierarchicalrequirement');
      if (isUs) starts.push(start);
      const total = isUs ? 6200 : 3;
      const count = Math.max(0, Math.min(200, total - start + 1));
      const Results = Array.from({ length: count }, (_, i) => ({ FormattedID: `US${start + i}`, ObjectID: start + i, ScheduleState: 'Defined' }));
      return new Response(JSON.stringify({ QueryResult: { Errors: [], Results, TotalResultCount: total } }));
    }) as unknown as typeof fetch;
    const rally = new Rally(db, fetcher);
    await rally.connect(marta, { apiKey: '_clave' });
    const report = await rally.itemsReport(marta, 0, ['7']);
    expect(starts).toHaveLength(25);
    expect(report.truncated).toEqual([{ kind: 'US', total: 6200, shown: 5000 }]);
    expect(report.items.filter((i) => i.kind === 'US')).toHaveLength(5000);
  });

  it('crea features con estado de portfolio, talla, fechas planificadas y padre', async () => {
    const { rally, marta, posts, gets } = await setup({ ...us, _ref: `${ws}/portfolioitem/initiative/5`, Name: 'Iniciativa' });
    const options = await rally.formOptions(marta, 'FE', '7');
    expect(gets.map((g) => g.pathname.replace('/slm/webservice/v2.0', ''))).toEqual(expect.arrayContaining(['/state', '/preliminaryestimate']));
    // Los estados se piden por la definición del tipo Feature (las columnas de su Portfolio Kanban).
    expect(gets.find((g) => g.pathname.endsWith('/typedefinition') && g.searchParams.get('query')?.includes('PortfolioItem/Feature'))).toBeTruthy();
    expect(gets.find((g) => g.pathname.endsWith('/state'))?.searchParams.get('query')).toBe('(TypeDef.ObjectID = 111)');
    expect(gets.some((g) => g.pathname.endsWith('/flowstate') || g.pathname.endsWith('/iteration'))).toBe(false);
    expect(options).toMatchObject({ scheduleStates: [], flowStates: [], iterations: [] });
    expect(options.portfolioStates).toEqual([{ ref: '/portfolioitem/initiative/5', name: 'Iniciativa' }]); // el Rally falso responde lo mismo

    await rally.create(marta, {
      kind: 'FE', name: 'Pagos Bizum', projectId: '7', portfolioStateRef: '/state/3', preliminaryEstimateRef: '/preliminaryestimate/2',
      plannedStart: '2026-11-10', plannedEnd: '2026-12-31', parentId: 'I-12', releaseRef: '/release/9', ready: true,
    });
    expect(posts).toEqual([{ path: '/portfolioitem/feature/create', body: { Feature: {
      Name: 'Pagos Bizum', Owner: '/user/42', Ready: true, Release: '/release/9', State: '/state/3', PreliminaryEstimate: '/preliminaryestimate/2',
      PlannedStartDate: '2026-11-10T12:00:00.000Z', PlannedEndDate: '2026-12-31T12:00:00.000Z', Parent: '/portfolioitem/initiative/5', Project: '/project/7' } } }]);
    await expect(rally.create(marta, { kind: 'FE', name: 'x', projectId: '7', plannedStart: '10/11/2026' })).rejects.toThrow(/Fecha/);
    await expect(rally.create(marta, { kind: 'FE', name: 'x', projectId: '7', portfolioStateRef: '/release/1' })).rejects.toThrow(/no válido/);
  });

  it('si una consulta de estados de Feature no vale, prueba la siguiente', async () => {
    const db = new DatabaseSync(':memory:');
    const api = new Api(db);
    const marta = api.register({ login: 'marta@vml.com', name: 'Marta', password: 'contraseña-larga', code: api.teamCode }).user;
    const ws = `${BASE}/slm/webservice/v2.0`;
    const states = ['Discovering', 'Refinement', 'Ready', 'Developing', 'Completed', 'Measuring']
      .map((Name, i) => ({ _ref: `${ws}/state/${i + 1}`, _refObjectName: Name, Name, OrderIndex: i + 1 }));
    const fetcher = (async (url: string) => {
      const u = new URL(url);
      const q = u.searchParams.get('query') ?? '';
      if (u.pathname.endsWith('/user')) return new Response(JSON.stringify({ User: { ObjectID: 42, DisplayName: 'Marta' } }));
      const Results = u.pathname.endsWith('/state') && q === '(TypeDef.Name = "Feature")' ? [...states].reverse() : [];
      return new Response(JSON.stringify({ QueryResult: { Errors: [], Results, TotalResultCount: Results.length } }));
    }) as unknown as typeof fetch;
    const rally = new Rally(db, fetcher);
    await rally.connect(marta, { apiKey: '_clave' });
    const options = await rally.formOptions(marta, 'FE', '7');
    expect(options.portfolioStates.map((x) => x.name)).toEqual(['Discovering', 'Refinement', 'Ready', 'Developing', 'Completed', 'Measuring']);
    expect(options.portfolioStates[0].ref).toBe('/state/1');
  });

  it('no mueve features desde el gestor', async () => {
    const { rally, marta } = await setup(us);
    await expect(rally.move(marta, { id: 'F12', category: 'done' })).rejects.toThrow(/features/);
  });

  it('rechaza lo que no se puede mover y explica una clave de solo lectura', async () => {
    const { rally, marta } = await setup(us, { readOnly: true });
    await expect(rally.move(marta, { id: 'TC9', category: 'done' })).rejects.toThrow(/test cases/);
    await expect(rally.move(marta, { id: 'US1', category: 'otra' })).rejects.toThrow(/no válido/);
    await expect(rally.move(marta, { id: 'US1', category: 'done' })).rejects.toThrow(/Full Access/);
  });
});

describe('Rally: gestor', () => {
  it('mueve las tareas enlazadas a la categoría que tienen en Rally', () => {
    const T = DEFAULT_ITEM_TYPES;
    const us = makeTask({ id: 'a', external_id: 'US1', type_id: 'us', state_id: 'us-dev' });
    const igual = makeTask({ id: 'b', external_id: 'US-2', type_id: 'us', state_id: 'us-dev' });
    const tema = makeTask({ id: 'c', external_id: 'DE3', type_id: 'topic', state_id: 'topic-pending' });
    const archivada = makeTask({ id: 'd', external_id: 'US4', status: 'archived' });
    const sinRally = makeTask({ id: 'e', external_id: null });
    const items = [
      item({ id: 'US1', category: 'accepted' }), item({ id: 'US2', category: 'doing' }),
      item({ id: 'DE3', kind: 'DE', category: 'accepted' }), item({ id: 'US4', category: 'accepted' }),
    ];
    const moves = rallyMoves([us, igual, tema, archivada, sinRally], items, T);
    // "Para hablar" no tiene Accepted: va a su estado de hecho.
    expect(moves.map((m) => `${m.task.id}→${m.stateId}`)).toEqual(['a→us-accepted', 'c→topic-done']);
    // Reabierta en Rally: vuelve al primer estado de esa categoría.
    expect(rallyMoves([makeTask({ external_id: 'US1', type_id: 'us', state_id: 'us-accepted', status: 'done' })], [item({ id: 'US1', category: 'todo' })], T)
      .map((m) => m.stateId)).toEqual(['us-backlog']);
    // Sin la categoría en su tipo (Para hablar no tiene "Bloqueado"), no se mueve.
    expect(rallyMoves([tema], [item({ id: 'DE3', kind: 'DE', category: 'blocked' })], T)).toEqual([]);
  });

  it('manda a Rally los cambios de categoría hechos en el gestor, también al deshacer', () => {
    const T = DEFAULT_ITEM_TYPES;
    const before = makeTask({ id: 'a', external_id: 'US-1', type_id: 'us', state_id: 'us-dev' });
    const after = { ...before, state_id: 'us-accepted', status: 'done' as const };
    const mismaCategoria = makeTask({ id: 'b', external_id: 'US2', type_id: 'us', state_id: 'us-dev' });
    const changes = [
      { table: 'tasks', before, after },
      { table: 'activity', before: undefined, after: { id: 'x' } },
      { table: 'tasks', before: mismaCategoria, after: { ...mismaCategoria, state_id: 'us-qa' } }, // En curso → En curso
      { table: 'tasks', before: undefined, after: makeTask({ external_id: 'US3', type_id: 'us', state_id: 'us-dev' }) }, // alta
      { table: 'tasks', before: makeTask({ external_id: 'TC4', state_id: 'task-todo' }), after: makeTask({ external_id: 'TC4', state_id: 'task-doing' }) },
      { table: 'tasks', before: makeTask({ external_id: 'JIRA-5', state_id: 'task-todo' }), after: makeTask({ external_id: 'JIRA-5', state_id: 'task-doing' }) },
    ];
    expect(pushIds(rallyPushes(changes, false, T))).toEqual([{ id: 'US1', category: 'accepted' }]);
    expect(pushIds(rallyPushes(changes, true, T))).toEqual([{ id: 'US1', category: 'doing' }]);
    // Completar y pasar a Accepted en la misma entrada: se manda Accepted; al deshacer, vuelve a En curso.
    const prod = { ...before, state_id: 'us-prod', status: 'done' as const };
    const twoSteps = [{ table: 'tasks', before, after: prod }, { table: 'tasks', before: prod, after }];
    expect(pushIds(rallyPushes(twoSteps, false, T))).toEqual([{ id: 'US1', category: 'accepted' }]);
    expect(pushIds(rallyPushes(twoSteps, true, T))).toEqual([{ id: 'US1', category: 'doing' }]);
    // Backlog → Refinada (Por hacer → Por hacer): se manda para pasar de New a Defined; al revés, no.
    const backlog = makeTask({ external_id: 'US7', type_id: 'us', state_id: 'us-backlog' });
    const refined = { ...backlog, state_id: 'us-refined' };
    expect(pushIds(rallyPushes([{ table: 'tasks', before: backlog, after: refined }], false, T))).toEqual([{ id: 'US7', category: 'todo' }]);
    expect(pushIds(rallyPushes([{ table: 'tasks', before: refined, after: backlog }], false, T))).toEqual([]);
  });

  it('reconoce los IDs de Rally (para mostrar su ficha en el panel de la tarea)', () => {
    for (const id of ['US1764574', 'us-12', 'DE9', 'TS215889', 'TA1', 'TC7', 'F789', 'FE12', 'DS3']) expect(isRallyId(id)).toBe(true);
    for (const id of [null, undefined, '', 'JIRA-5', 'US', 'FX1', 'US1 extra']) expect(isRallyId(id)).toBe(false);
  });

  it('solo pide a Rally los IDs de las tareas activas, sin repetir', () => {
    expect(rallyIdsOf([
      makeTask({ external_id: 'US-1' }), makeTask({ external_id: 'us1' }), makeTask({ external_id: 'TS22' }),
      makeTask({ external_id: 'JIRA-5' }), makeTask({ external_id: 'DE9', status: 'archived' }), makeTask({ external_id: 'TC7', deleted_at: '2026-10-01T00:00:00Z' }),
    ])).toEqual(['US1', 'TS22']);
  });

  it('reconoce las tareas ya traídas aunque el ID lleve guion', () => {
    const byId = tasksByRallyId([makeTask({ external_id: 'US-1' }), makeTask({ external_id: null })]);
    expect(linkedTask(item(), byId)?.external_id).toBe('US-1');
    expect(linkedTask(item({ id: 'US2' }), byId)).toBeUndefined();
  });

  it('crea la tarea con el tipo por prefijo, el ID, el enlace y el proyecto elegido', () => {
    const us = DEFAULT_ITEM_TYPES.find((t) => t.short === 'US')!;
    const t = taskFromRally(item({ project: 'Caixa', iteration: 'Sprint 14' }), DEFAULT_ITEM_TYPES, 'p1');
    expect(t).toMatchObject({ title: 'Uno', external_id: 'US1', url: `${BASE}/#/detail/userstory/1`, type_id: us.id, project_id: 'p1' });
    expect(t.notes).toBe('Proyecto en Rally: Caixa\nIteración: Sprint 14');
    expect(taskFromRally(item({ kind: 'DE' }), DEFAULT_ITEM_TYPES, null).type_id).toBe('task');
  });

  it('agrupa por categoría (siempre las cinco), por columna (en el orden del tablero), por iteración (la más reciente primero) o por persona', () => {
    const list = [
      item({ state: 'Need Review', stateOrder: 6, iteration: null, assignee: 'Marc' }),
      item({ state: 'New', stateOrder: 1, iteration: 'Sprint 9', assignee: null }),
      item({ state: 'Defined', stateOrder: 2, iteration: 'Sprint 14', assignee: 'Ana' }),
    ];
    expect(groupRally(list, 'state').map((g) => g.key)).toEqual(['New', 'Defined', 'Need Review']);
    const byCategory = groupRally([item({ category: 'accepted' }), item({ category: 'blocked' }), item({ category: 'accepted' })], 'category');
    expect(byCategory.map((g) => `${g.key} ${g.items.length}`)).toEqual(['Por hacer 0', 'Bloqueado 1', 'En curso 0', 'Hecho 0', 'Accepted 2']);
    expect(groupRally(list, 'iteration').map((g) => g.key)).toEqual(['Sprint 14', 'Sprint 9', null]);
    expect(groupRally(list, 'assignee').map((g) => g.key)).toEqual(['Ana', 'Marc', null]);
    const tagged = [item({ id: 'TS1', tags: ['QA Marc', 'iOS'] }), item({ id: 'TS2', tags: ['iOS'] }), item({ id: 'TS3' })];
    expect(groupRally(tagged, 'tag').map((g) => `${g.key} ${g.items.map((i) => i.id).join('+')}`)).toEqual(['iOS TS1+TS2', 'QA Marc TS1', 'null TS3']);
  });

  it('lleva las etiquetas de Rally a la tarea del gestor', () => {
    expect(taskFromRally(item({ tags: ['QA Marc'] }), DEFAULT_ITEM_TYPES, null).tags).toEqual(['QA Marc']);
  });

  it('apunta el Assignee en la tarea solo si no es de la persona conectada', () => {
    expect(taskFromRally(item({ mine: false, assignee: 'Ana' }), DEFAULT_ITEM_TYPES, null).notes).toBe('Assignee en Rally: Ana');
    expect(taskFromRally(item({ assignee: 'Marc' }), DEFAULT_ITEM_TYPES, null).notes).toBe('');
  });
});
