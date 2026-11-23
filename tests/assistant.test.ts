import { describe, expect, it } from 'vitest';
import { buildChunks, findPerson, matchTasks, parseIntent, queryTasks } from '../src/domain/assistant';
import { SearchIndex, splitSections, terms } from '../src/domain/knowledge';
import { DEFAULT_ITEM_TYPES } from '../src/domain/workflows';
import type { Project } from '../src/domain/types';
import { makeTask } from './factories';

const today = '2026-11-23'; // lunes
const project = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id, color: '#000', archived: false, created_at: '', updated_at: '', sort_order: null }) as unknown as Project;
const projects = [project('p1', 'Caixa'), project('p2', 'Imagin', 'p1'), project('p3', 'Fundación Cadete')];
const ctx = { today, people: ['Ana Ruiz', 'Diana López', 'Luis', 'Marc Crespo'], projects };
const intent = (t: string) => parseIntent(t, ctx);

describe('Asistente: lo que entiende', () => {
  it('tareas con periodo, persona, proyecto y estado', () => {
    expect(intent('¿Qué tengo hoy?')).toMatchObject({ kind: 'tasks', query: { when: 'today' } });
    expect(intent('tareas atrasadas')).toMatchObject({ kind: 'tasks', query: { when: 'overdue' }, label: 'Tareas pendientes atrasadas' });
    expect(intent('tareas de Ana esta semana')).toMatchObject({ kind: 'tasks', query: { person: 'Ana Ruiz', when: { from: today, to: '2026-11-29' } } });
    expect(intent('bloqueadas en #caixa')).toMatchObject({ kind: 'tasks', query: { category: 'blocked', projectId: 'p1' } });
    expect(intent('qué hay pendiente en Fundación Cadete')).toMatchObject({ kind: 'tasks', query: { projectId: 'p3' } });
    expect(intent('tareas para mañana')).toMatchObject({ kind: 'tasks', query: { when: { from: '2026-11-24', to: '2026-11-24' } } });
    expect(intent('US1234')).toMatchObject({ kind: 'tasks', query: { externalId: 'US1234' } });
    expect(intent('¿qué he hecho esta semana?')).toEqual({ kind: 'done', from: today, to: today, label: 'esta semana' });
    expect(intent('qué hice ayer')).toMatchObject({ kind: 'done', from: '2026-11-22', to: '2026-11-22' });
  });

  it('personas y notas', () => {
    expect(intent('¿Qué dijo Diana?')).toEqual({ kind: 'said', person: 'Diana López' });
    expect(intent('temas para hablar con Luis')).toEqual({ kind: 'topics', person: 'Luis' });
    expect(intent('quién es @Ana')).toEqual({ kind: 'person', person: 'Ana Ruiz' });
    expect(findPerson('reunión con marc', ctx.people)).toBe('Marc Crespo');
    expect(findPerson('sin nadie', ctx.people)).toBeUndefined();
  });

  it('órdenes', () => {
    expect(intent('Crea una tarea revisar login para el viernes #caixa !1')).toEqual({ kind: 'create-task', text: 'revisar login para el viernes #caixa !1' });
    expect(intent('recuérdame llamar a Ana')).toEqual({ kind: 'create-task', text: 'llamar a Ana' });
    expect(intent('recuérdame a las 9 llamar a Ana')).toEqual({ kind: 'create-task', text: 'recuérdame a las 9 llamar a Ana' });
    expect(intent('Crea una nota Reunión con Ana: hablar del sprint')).toEqual({ kind: 'create-note', title: 'Reunión con Ana', body: 'hablar del sprint' });
    expect(intent('completa revisar login')).toMatchObject({ kind: 'act', action: 'complete', query: 'revisar login' });
    expect(intent('he terminado el informe')).toMatchObject({ kind: 'act', action: 'complete', query: 'el informe' });
    expect(intent('pon revisar login en curso')).toMatchObject({ kind: 'act', action: 'state', query: 'revisar login', category: 'doing' });
    expect(intent('pasa el informe a bloqueada')).toMatchObject({ kind: 'act', action: 'state', query: 'el informe', category: 'blocked' });
    expect(intent('mueve revisar login a mañana')).toMatchObject({ kind: 'act', action: 'date', query: 'revisar login', date: '2026-11-24' });
    expect(intent('pospón revisar login')).toMatchObject({ kind: 'act', action: 'date', date: '2026-11-24' });
    expect(intent('añade revisar login a mi día')).toMatchObject({ kind: 'act', action: 'my-day', query: 'revisar login' });
  });

  it('lo demás, a buscar (la documentación si se pregunta cómo se hace algo)', () => {
    expect(intent('¿Cómo se entrega una guía?')).toEqual({ kind: 'search', query: '¿Cómo se entrega una guía?', sources: ['doc', 'note'] });
    expect(intent('presupuesto navidad')).toEqual({ kind: 'search', query: 'presupuesto navidad', sources: undefined });
    expect(intent('ayuda')).toEqual({ kind: 'help' });
  });
});

describe('Asistente: tareas', () => {
  const types = DEFAULT_ITEM_TYPES;
  const tasks = [
    makeTask({ id: 'a', title: 'Revisar login', due_date: '2026-11-20', people: ['Ana Ruiz'], project_id: 'p2' }),
    makeTask({ id: 'b', title: 'Informe mensual', due_date: '2026-11-25', people: ['Luis'] }),
    makeTask({ id: 'c', title: 'Llamar a proveedor', state_id: 'task-blocked', project_id: 'p1' }),
    makeTask({ id: 'd', title: 'Revisar login antiguo', status: 'done', completed_at: '2026-11-21T10:00:00Z', external_id: 'US-1234' }),
  ];
  const q = (query: Parameters<typeof queryTasks>[1]) => queryTasks(tasks, query, { today, projects, types }).map((t) => t.id);

  it('consulta por periodo, persona, proyecto (con subproyectos), estado e ID', () => {
    expect(q({ when: 'today' })).toEqual(['a']);
    expect(q({ when: 'overdue' })).toEqual(['a']);
    expect(q({ when: { from: today, to: '2026-11-29', label: '' } })).toEqual(['b']);
    expect(q({ person: 'Ana Ruiz' })).toEqual(['a']);
    expect(q({ projectId: 'p1' })).toEqual(['a', 'c']);
    expect(q({ category: 'blocked' })).toEqual(['c']);
    expect(q({ category: 'done' })).toEqual(['d']);
    expect(q({ externalId: 'US1234' })).toEqual(['d']);
    expect(q({ when: 'nodate' })).toEqual(['c']);
  });

  it('encuentra la tarea por su título para las órdenes', () => {
    expect(matchTasks(tasks, 'revisar login').map((t) => t.id)).toEqual(['a']);
    expect(matchTasks(tasks, 'revisar login', false).map((t) => t.id)).toEqual(['a', 'd']);
    expect(matchTasks(tasks, 'informe').map((t) => t.id)).toEqual(['b']);
    expect(matchTasks(tasks, 'nada parecido')).toEqual([]);
  });
});

describe('Asistente: buscador', () => {
  const guide = `# Entrega de la guía
Cuando la US está en Completed, se avisa al PO y al analista.

## Validación en PRE
Las validaciones se hacen en PRE con el documento de validación. Si hay errores, se abre un defecto.

## Etiquetado
Revisar las etiquetas de Adobe en todas las páginas.`;

  it('trocea por apartados y quita tildes, palabras vacías y plurales', () => {
    expect(splitSections(guide).map((s) => s.section)).toEqual(['Entrega de la guía', 'Validación en PRE', 'Etiquetado']);
    expect(splitSections('REQUISITOS\nuno\n\nPasos a seguir:\ndos').map((s) => [s.section, s.text])).toEqual([['REQUISITOS', 'uno'], ['Pasos a seguir', 'dos']]);
    expect(terms('¿Cómo se hacen las validaciones en PRE?')).toEqual(['hacen', 'validacion', 'pre']);
  });

  it('el trozo que mejor responde primero, con las palabras marcadas', () => {
    const index = new SearchIndex(buildChunks({
      tasks: [makeTask({ id: 't1', title: 'Validar etiquetas de la home' })],
      notes: [], people: [{ name: 'Ana Ruiz', role: 'PO de Imagin', notes: '', email: 'ana@x.com' }], projects,
      docs: [{ id: 'g', title: 'Guía del equipo', body: guide }],
    }));
    const hits = index.search('¿cómo se hace la validación en PRE?');
    expect(hits[0].chunk).toMatchObject({ source: 'doc', ref: 'g', section: 'Validación en PRE' });
    const marked = hits[0].marks.map(([s, e]) => hits[0].snippet.slice(s, e).toLowerCase());
    expect(marked).toContain('pre');
    expect(marked.some((m) => m.startsWith('validaci'))).toBe(true);
    expect(index.search('PO Imagin')[0].chunk).toMatchObject({ source: 'person', ref: 'Ana Ruiz' });
    expect(index.search('etiquetas', { sources: ['task'] })[0].chunk.ref).toBe('t1');
    expect(index.search('de la que')).toEqual([]);
  });

  it('también encuentra los elementos de la Lista, por su título o sus columnas', () => {
    const index = new SearchIndex(buildChunks({ tasks: [], notes: [], people: [], projects: [], docs: [],
      listItems: [
        { id: '151', title: 'AA BANKSY', fields: { Estado: 'En curso', 'Tarea madre': 'BANKSY', Comentarios: 'pendiente de validar la medición en PRE' } },
        { id: '152', title: 'Fuentes de tráfico', fields: { Estado: 'Backlog' } },
      ] }));
    expect(index.search('medicion banksy')[0].chunk).toMatchObject({ source: 'list', ref: '151' });
    expect(index.search('trafico')[0].chunk).toMatchObject({ source: 'list', ref: '152' });
  });
});

describe('Asistente: documentación en SharePoint', async () => {
  const { spDocs, kqlFrom, summaryMarks } = await import('../src/features/assistant/spDocs');
  const SITE = 'https://wpp.sharepoint.com/sites/Equipo';
  const FOLDER = '/sites/Equipo/Shared Documents/Marea';
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json;odata=nometadata' } });

  /** Un Word mínimo: ZIP con word/document.xml comprimido (como los de verdad). */
  const { deflateRawSync } = await import('node:zlib');
  const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Medición</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">La evar 69 es para el </w:t></w:r><w:r><w:t>login &amp; SSO</w:t></w:r></w:p></w:body></w:document>';
  const docx = (() => {
    const raw = Buffer.from(xml);
    const data = deflateRawSync(raw);
    const name = Buffer.from('word/document.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    return new Uint8Array(Buffer.concat([local, name, data, dir, name, end]));
  })();

  function fakeSp() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const u = decodeURIComponent(url);
      if (u.includes('/_api/v2.0/shares/u!')) return json({ name: 'Marea', webUrl: `https://wpp.sharepoint.com${encodeURI(FOLDER)}` });
      if (u.endsWith('/_api/web?$select=Title,Url')) return json({ Title: 'Equipo', Url: SITE });
      if (u.includes('GetFolderByServerRelativePath') && u.includes('/Files/AddUsingPath')) return json({ Name: 'guía.pdf', ServerRelativeUrl: `${FOLDER}/guía.pdf` });
      if (u.includes('GetFolderByServerRelativePath') && u.includes('/Files?')) {
        return json({ value: u.includes(`'${FOLDER}/Sub'`)
          ? [{ Name: 'notas.md', ServerRelativeUrl: `${FOLDER}/Sub/notas.md`, TimeLastModified: '2026-11-22T10:00:00Z', Length: '30' }]
          : [{ Name: 'a.docx', ServerRelativeUrl: `${FOLDER}/a.docx`, TimeLastModified: '2026-11-20T10:00:00Z', Length: '2048' },
            { Name: 'informe.pdf', ServerRelativeUrl: `${FOLDER}/informe.pdf`, TimeLastModified: '2026-11-19T10:00:00Z', Length: '9000' }] });
      }
      if (u.includes('GetFolderByServerRelativePath') && u.includes('/Folders?')) {
        return json({ value: u.includes(`'${FOLDER}/Sub'`) ? [] : [{ Name: 'Forms', ServerRelativeUrl: `${FOLDER}/Forms` }, { Name: 'Sub', ServerRelativeUrl: `${FOLDER}/Sub` }] });
      }
      if (u.includes('GetFileByServerRelativePath') && u.includes('a.docx')) return new Response(docx);
      if (u.includes('GetFileByServerRelativePath') && u.includes('notas.md')) return new Response('# Notas\nEl login va por SSO');
      if (u.includes('GetFolderByServerRelativePath')) return json({ Name: 'Marea', ServerRelativeUrl: FOLDER });
      if (u.endsWith('/_api/contextinfo')) return json({ FormDigestValue: 'dg' });
      if (u.includes('/_api/search/query')) {
        const or = u.includes(' OR ');
        return json({ PrimaryQueryResult: { RelevantResults: { Table: { Rows: or ? [{ Cells: [
          { Key: 'Title', Value: 'Guía de entrega' }, { Key: 'Path', Value: `${SITE}/Shared Documents/guia.docx` },
          { Key: 'HitHighlightedSummary', Value: 'Se <c0>valida</c0> en <c1>PRE</c1> &amp; PRO<ddd/>' }, { Key: 'Author', Value: 'Ana;Luis' }, { Key: 'FileType', Value: 'docx' },
        ] }] : [] } } } });
      }
      return new Response('no', { status: 404 });
    };
    return { fetch, calls };
  }

  async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = f;
    try { return await run(); } finally { globalThis.fetch = real; }
  }

  it('resuelve la carpeta desde la dirección del navegador o un enlace de «compartir»', async () => {
    const sp = fakeSp();
    const out = { siteUrl: SITE, siteTitle: 'Equipo', folder: FOLDER, folderName: 'Marea', folderUrl: `https://wpp.sharepoint.com${encodeURI(FOLDER)}` };
    await withFetch(sp.fetch as typeof fetch, async () => {
      expect(await spDocs('resolve', { url: `${SITE}/Shared%20Documents/Forms/AllItems.aspx?id=${encodeURIComponent(FOLDER)}&viewid=x` })).toEqual(out);
      expect(await spDocs('resolve', { url: 'https://wpp.sharepoint.com/:f:/s/Equipo/AbCdEf?e=1' })).toEqual(out);
      await expect(spDocs('resolve', { url: 'https://evil.es/x' })).rejects.toThrow(/no es de SharePoint/);
    });
    expect(sp.calls.some((c) => c.url.includes('/_api/v2.0/shares/u!'))).toBe(true);
  });

  it('busca con el buscador de SharePoint (todas las palabras y, si no, alguna) en el alcance elegido', async () => {
    const sp = fakeSp();
    const kql = kqlFrom('¿Cómo se valida en PRE la guía?', (w) => ['como', 'cómo', 'se', 'en', 'la'].includes(w.toLowerCase()))!;
    expect(kql).toEqual({ query: 'valida PRE guía', orQuery: 'valida OR PRE OR guía' });
    const r = await withFetch(sp.fetch as typeof fetch, () => spDocs('search', { siteUrl: SITE, scope: `${SITE}/Shared Documents`, ...kql, limit: 5 }));
    expect(r.loose).toBe(true);
    expect(r.hits).toEqual([{ title: 'Guía de entrega', url: `${SITE}/Shared Documents/guia.docx`, summary: 'Se <c0>valida</c0> en <c1>PRE</c1> &amp; PRO<ddd/>', author: 'Ana;Luis', modified: '', type: 'docx' }]);
    const first = decodeURIComponent(sp.calls[0].url);
    expect(first).toContain(`querytext='valida PRE guía path:"${SITE}/Shared Documents"'`);
    expect(first).toContain('rowlimit=5');
    const s = summaryMarks(r.hits[0].summary);
    expect(s.text).toBe('Se valida en PRE & PRO…');
    expect(s.marks.map(([a, b]) => s.text.slice(a, b))).toEqual(['valida', 'PRE']);
  });

  it('lista la carpeta y sube archivos sin sustituir los que ya hay', async () => {
    const sp = fakeSp();
    await withFetch(sp.fetch as typeof fetch, async () => {
      const listed = await spDocs('list', { siteUrl: SITE, folder: FOLDER });
      // Con las subcarpetas (sin «Forms»), los más recientes primero.
      expect(listed.total).toBe(3);
      expect(listed.files.map((f: { name: string; folder: string }) => `${f.folder}/${f.name}`)).toEqual(['Sub/notas.md', '/a.docx', '/informe.pdf']);
      const up = await spDocs('upload', { siteUrl: SITE, folder: FOLDER, name: 'guía.pdf', base64: btoa('hola') });
      expect(up).toEqual({ name: 'guía.pdf', url: `https://wpp.sharepoint.com${encodeURI(`${FOLDER}/guía.pdf`)}` });
    });
    const call = sp.calls.find((c) => c.url.includes('AddUsingPath'))!;
    expect(decodeURIComponent(call.url)).toContain("overwrite=false)?@n='guía.pdf'&@p='/sites/Equipo/Shared Documents/Marea'");
    expect((call.init!.headers as Record<string, string>)['X-RequestDigest']).toBe('dg');
    expect(new TextDecoder().decode(call.init!.body as Uint8Array)).toBe('hola');
  });

  it('lee al momento los Word y textos de la carpeta (y subcarpetas) y solo baja los que han cambiado', async () => {
    const sp = fakeSp();
    const first = await withFetch(sp.fetch as typeof fetch, () => spDocs('texts', { siteUrl: SITE, folder: FOLDER }));
    // El PDF no se lee aquí (lo busca SharePoint); el Word y el Markdown, sí.
    expect(first.total).toBe(2);
    const word = first.files.find((f: { name: string }) => f.name === 'a.docx');
    expect(word.text).toBe('# Medición\nLa evar 69 es para el login & SSO');
    expect(first.files.find((f: { name: string }) => f.name === 'notas.md')).toMatchObject({ folder: 'Sub', text: '# Notas\nEl login va por SSO' });
    const known = Object.fromEntries(first.files.map((f: { url: string; modified: string }) => [f.url, f.modified]));
    const again = await withFetch(sp.fetch as typeof fetch, () => spDocs('texts', { siteUrl: SITE, folder: FOLDER, known }));
    expect(again.files.every((f: { unchanged?: boolean }) => f.unchanged)).toBe(true);

    // Y el Asistente lo encuentra con la pregunta tal cual.
    const index = new SearchIndex(buildChunks({ tasks: [], notes: [], people: [], projects: [],
      docs: first.files.map((f: { url: string; name: string; text: string }) => ({ id: f.url, title: f.name, body: f.text })) }));
    const hits = index.search('me puedes decir que evar se usa para el login?', { sources: ['doc'] });
    expect(hits[0].chunk.title).toBe('a.docx');
    expect(hits[0].snippet).toContain('La evar 69 es para el login');
  });
});
