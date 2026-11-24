import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ITEM_TYPES } from '../src/domain/workflows';
import { activityLog, findPersonName, listTasks, noteDetail, personDetail, projectDetail, search, taskDetail, type MareaData } from '../src/domain/mcpTools';
import type { Note, Project } from '../src/domain/types';
import { madridToday } from '../servidor/mcp';
import { makeTask } from './factories';

const ME = 'u-me';
const project = (id: string, name: string, parent_id: string | null = null): Project =>
  ({ id, name, color: '#000', archived: false, created_at: '2026-01-01T00:00:00Z', parent_id });
const note = (o: Partial<Note>): Note => ({
  id: 'n1', title: 'Reunión', body: '', kind: 'meeting', date: '2026-11-20', project_id: null, people: [], pinned: false, task_id: null,
  meeting_url: null, sort_order: null, created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T09:00:00Z', deleted_at: null, ...o,
}) as Note;

function data(): MareaData {
  const us = DEFAULT_ITEM_TYPES.find((t) => t.id === 'task')!;
  return {
    today: '2026-11-24',
    base: 'https://marea.test',
    me: { id: ME, name: 'Marta García' },
    types: [...DEFAULT_ITEM_TYPES.filter((t) => t.id !== 'us'), { ...us, id: 'us', name: 'User Story', short: 'US', url_template: 'https://rally/{id}' }],
    projects: [project('p1', 'Caixa'), project('p2', 'Imagin', 'p1')],
    people: [{ name: 'Diana López', role: 'PO', notes: '', email: 'diana@x.com' }],
    tasks: [
      { ...makeTask({ id: 't1', title: 'Revisar evar 69 del login', project_id: 'p2', people: ['Diana López'], due_date: '2026-11-20', priority: 1 }), owner: ME },
      { ...makeTask({ id: 't2', title: 'Guía de etiquetado home', type_id: 'us', external_id: 'US1234567', project_id: 'p1' }), owner: 'u-otro' },
      { ...makeTask({ id: 't3', title: 'Hecha hace poco', status: 'done', state_id: 'done', completed_at: '2026-11-23T10:00:00Z' }), owner: ME },
      { ...makeTask({ id: 't4', title: 'Borrada', deleted_at: '2026-11-22T10:00:00Z' }), owner: ME },
    ],
    notes: [note({ id: 'n1', title: 'Sync con Diana', project_id: 'p1', people: ['Diana López'],
      body: '## Decisiones\n- @Diana-López: la evar 69 se usa para el login\n- [ ] Revisar evar 69 [[t:t1]]' })],
    activity: [{ id: 'a1', at: '2026-11-23T10:00:00Z', date: '2026-11-23', kind: 'completed', task_id: 't3', title: 'Hecha hace poco', project_id: null, from: null, to: null }],
    accounts: new Map([[ME, 'Marta García'], ['u-otro', 'Mark Pérez']]),
  };
}

describe('herramientas de Marea para Claude', () => {
  it('lista las pendientes con filtros y no enseña borradas ni hechas', () => {
    const out = listTasks(data(), {});
    expect(out).toMatch(/^2 tareas/);
    expect(out).not.toContain('Borrada');
    expect(out).not.toContain('Hecha hace poco');
    expect(listTasks(data(), { persona: 'diana' })).toContain('Revisar evar 69');
    expect(listTasks(data(), { proyecto: 'caixa' })).toMatch(/^2 tareas/); // incluye el subproyecto
    expect(listTasks(data(), { cuando: 'atrasadas' })).toMatch(/^1 tarea /);
    expect(listTasks(data(), { tipo: 'US' })).toContain('US1234567');
    expect(listTasks(data(), { estado: 'hechas' })).toContain('Hecha hace poco');
    expect(listTasks(data(), { persona: 'Nadie' })).toContain('No conozco');
  });

  it('cada tarea lleva sus enlaces y de quién es', () => {
    const out = listTasks(data(), { tipo: 'US' });
    expect(out).toContain('Rally: https://rally/US1234567');
    expect(out).toContain('de: Mark Pérez');
    expect(out).toContain('proyecto: Caixa');
  });

  it('busca en tareas y notas', () => {
    const out = search(data(), 'evar 69 login');
    expect(out).toContain('[Tarea]');
    expect(out).toContain('[Nota]');
    expect(out).toContain('https://marea.test/#/notes/n1');
  });

  it('ve una tarea por ID de Rally, por título o por id', () => {
    expect(taskDetail(data(), 'US-1234567')).toContain('# US1234567 · Guía de etiquetado home');
    expect(taskDetail(data(), 'revisar evar')).toContain('Notas relacionadas');
    expect(taskDetail(data(), 't3')).toContain('Historial');
    expect(taskDetail(data(), 'nada parecido')).toContain('No encuentro');
  });

  it('enseña la nota con las tareas que salieron de ella', () => {
    expect(noteDetail(data(), 'n1')).toContain('(→ tarea «Revisar evar 69 del login», ');
    expect(noteDetail(data(), 'n1')).not.toContain('[[t:');
  });

  it('ficha de persona con lo que dijo', () => {
    expect(findPersonName(data(), '@diana')).toBe('Diana López');
    const out = personDetail(data(), 'Diana');
    expect(out).toContain('Rol: PO');
    expect(out).toContain('la evar 69 se usa para el login');
  });

  it('resumen de proyecto y registro', () => {
    expect(projectDetail(data(), 'Caixa')).toContain('2 pendientes');
    expect(activityLog(data(), '2026-11-23', '2026-11-24')).toContain('## Hechas (1)');
  });

  it('hoy es el día de Madrid aunque el servidor vaya en UTC', () => {
    expect(madridToday(new Date('2026-11-24T23:30:00Z'))).toBe('2026-11-25');
  });
});

describe('función /api/mcp', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  async function handler() {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://sb.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    const d = data();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/rpc/me')) return Response.json({ user: { id: ME, login: 'marta@x.com', name: 'Marta García' } });
      if (url.includes('/records?')) return Response.json([
        ...d.tasks.map(({ owner, ...t }) => ({ tbl: 'tasks', key: t.id, scope: '', owner, data: t })),
        ...d.notes.map((n) => ({ tbl: 'notes', key: n.id, scope: '', owner: ME, data: n })),
        ...d.projects.map((p) => ({ tbl: 'projects', key: p.id, scope: '', owner: ME, data: p })),
        ...d.types.map((t) => ({ tbl: 'item_types', key: t.id, scope: '', owner: null, data: t })),
      ]);
      if (url.includes('/overlays?')) return Response.json([{ key: 't2', data: { my_day: '2026-11-24' } }]);
      if (url.includes('/profiles?')) return Response.json([{ id: ME, name: 'Marta García' }]);
      return new Response('{}', { status: 404 });
    }));
    return (await import('../api/mcp')).default;
  }
  const rpc = (body: unknown, token = 'tok') => new Request('https://marea.test/api/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

  it('sin sesión pide entrar y dice dónde (OAuth)', async () => {
    const api = await handler();
    const res = await api.fetch(new Request('https://marea.test/api/mcp', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('https://marea.test/.well-known/oauth-protected-resource/api/mcp');
    const prm = await (await api.fetch(new Request('https://marea.test/api/mcp?route=prm'))).json();
    expect(prm).toMatchObject({ resource: 'https://marea.test/api/mcp', authorization_servers: ['https://sb.test/auth/v1'] });
  });

  it('se inicia, lista herramientas y responde con los datos de la persona', async () => {
    const api = await handler();
    const init = await api.fetch(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe('marea');
    expect(initBody.result.instructions).toContain('Marea');

    const tools = await (await api.fetch(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json();
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['buscar', 'listar_tareas', 'ver_tarea', 'ver_nota', 'ver_persona', 'ver_proyecto', 'listar_proyectos', 'mi_registro']));

    const call = await (await api.fetch(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listar_tareas', arguments: { cuando: 'mi_dia' } } }))).json();
    expect(call.result.content[0].text).toContain('Guía de etiquetado home'); // «Mi día» viene de overlays
  });
});
