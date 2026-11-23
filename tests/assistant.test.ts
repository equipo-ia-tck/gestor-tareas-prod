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
      docs: [{ id: 'g', title: 'Guía del equipo', kind: 'markdown', fileName: 'guia.md', visibility: 'team', ownerName: 'Marc', mine: true, size: guide.length, body: guide, createdAt: '', updatedAt: '' }],
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
});

describe('Asistente: documentación en SharePoint', async () => {
  const { spDocs, kqlFrom, summaryMarks } = await import('../src/features/assistant/spDocs');
  const SITE = 'https://wpp.sharepoint.com/sites/Equipo';
  const FOLDER = '/sites/Equipo/Shared Documents/Marea';
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json;odata=nometadata' } });

  function fakeSp() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const u = decodeURIComponent(url);
      if (u.includes('/_api/v2.0/shares/u!')) return json({ name: 'Marea', webUrl: `https://wpp.sharepoint.com${encodeURI(FOLDER)}` });
      if (u.endsWith('/_api/web?$select=Title,Url')) return json({ Title: 'Equipo', Url: SITE });
      if (u.includes('GetFolderByServerRelativePath') && u.includes('/Files/AddUsingPath')) return json({ Name: 'guía.pdf', ServerRelativeUrl: `${FOLDER}/guía.pdf` });
      if (u.includes('GetFolderByServerRelativePath') && u.includes('/Files?')) return json({ value: [{ Name: 'a.docx', ServerRelativeUrl: `${FOLDER}/a.docx`, TimeLastModified: '2026-11-20T10:00:00Z', Length: '2048' }] });
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
      expect(await spDocs('list', { siteUrl: SITE, folder: FOLDER })).toEqual({ files: [{ name: 'a.docx', url: `https://wpp.sharepoint.com${encodeURI(FOLDER)}/a.docx`, modified: '2026-11-20T10:00:00Z', size: 2048 }] });
      const up = await spDocs('upload', { siteUrl: SITE, folder: FOLDER, name: 'guía.pdf', base64: btoa('hola') });
      expect(up).toEqual({ name: 'guía.pdf', url: `https://wpp.sharepoint.com${encodeURI(`${FOLDER}/guía.pdf`)}` });
    });
    const call = sp.calls.find((c) => c.url.includes('AddUsingPath'))!;
    expect(decodeURIComponent(call.url)).toContain("overwrite=false)?@n='guía.pdf'&@p='/sites/Equipo/Shared Documents/Marea'");
    expect((call.init!.headers as Record<string, string>)['X-RequestDigest']).toBe('dg');
    expect(new TextDecoder().decode(call.init!.body as Uint8Array)).toBe('hola');
  });
});
