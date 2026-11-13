import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { TasksDB } from '../src/data/db';
import { DexieRepository } from '../src/data/repository';
import { externalUrl, groupReleases, releaseCountdown, releaseProgress } from '../src/domain/releases';
import { DEFAULT_ITEM_TYPES, findType, withAcceptedState } from '../src/domain/workflows';
import type { ItemType } from '../src/domain/types';
import { makeTask } from './factories';

let repo: DexieRepository;
beforeEach(() => { repo = new DexieRepository(new TasksDB(`v3-${crypto.randomUUID()}`)); });

describe('migración v2 → v3', () => {
  it('añade ID externo, enlace y release vacíos', async () => {
    const name = `mig3-${crypto.randomUUID()}`;
    const v2 = new Dexie(name);
    v2.version(2).stores({ projects: 'id', tasks: 'id, status, type_id', settings: 'key', meta: 'key', labels: 'name', item_types: 'id' });
    await v2.table('tasks').add({ id: 'a', title: 'x', status: 'todo', type_id: 'task', state_id: 'task-todo', checklist: [], tags: [], people: [] });
    v2.close();
    const db = new TasksDB(name);
    expect(await db.tasks.get('a')).toMatchObject({ external_id: null, url: null, release_id: null });
    expect(await db.releases.count()).toBe(0);
  });
});

describe('releases', () => {
  it('crear, actualizar y eliminar (quita la release de sus tareas, con deshacer)', async () => {
    const r = await repo.createRelease('R2.3', { date: '2026-10-20' });
    const t = await repo.createTask({ title: 'US login', type_id: 'us', release_id: r.id });
    await repo.updateRelease(r.id, { status: 'released' });
    expect((await repo.listReleases())[0]).toMatchObject({ name: 'R2.3', status: 'released' });
    await repo.deleteRelease(r.id);
    expect(await repo.listReleases()).toHaveLength(0);
    expect((await repo.getTask(t.id))?.release_id).toBeNull();
    await repo.undo();
    expect(await repo.listReleases()).toHaveLength(1);
    expect((await repo.getTask(t.id))?.release_id).toBe(r.id);
  });

  it('progreso por tipo y estado', () => {
    const tasks = [
      makeTask({ release_id: 'r', type_id: 'us', state_id: 'us-qa' }),
      makeTask({ release_id: 'r', type_id: 'us', state_id: 'us-prod', status: 'done' }),
      makeTask({ release_id: 'r', type_id: 'ts', state_id: 'ts-failed' }),
      makeTask({ release_id: 'otra' }),
    ];
    tasks[1].state_id = 'us-prod';
    tasks[1].type_id = 'us';
    const p = releaseProgress('r', tasks, DEFAULT_ITEM_TYPES);
    expect(p).toMatchObject({ total: 3, done: 1, blocked: 1 });
    expect(p.byType.map((b) => [b.type.short, b.states.map((s) => `${s.state.name}:${s.count}`)])).toEqual([
      ['US', ['En QA:1', 'En producción:1']],
      ['TS', ['Fallido:1']],
    ]);
  });

  it('cuenta atrás y agrupación', () => {
    const today = '2026-10-07';
    expect(releaseCountdown({ date: '2026-10-12', status: 'planned' }, today)).toBe('en 5 días');
    expect(releaseCountdown({ date: '2026-10-05', status: 'planned' }, today)).toBe('hace 2 días');
    expect(releaseCountdown({ date: null, status: 'planned' }, today)).toBe('sin fecha');
    const base = { project_id: null, notes: '', created_at: '' };
    const g = groupReleases([
      { ...base, id: 'a', name: 'A', date: '2026-10-20', status: 'planned' },
      { ...base, id: 'b', name: 'B', date: '2026-10-01', status: 'planned' },
      { ...base, id: 'c', name: 'C', date: '2026-09-01', status: 'released' },
    ], today);
    expect([g.upcoming, g.overdue, g.finished].map((x) => x.map((r) => r.id))).toEqual([['a'], ['b'], ['c']]);
  });
});

describe('enlaces externos', () => {
  const us = { ...findType(DEFAULT_ITEM_TYPES, 'us'), url_template: 'https://jira.example.com/browse/{id}' };
  it('usa el enlace explícito o la plantilla', () => {
    expect(externalUrl({ url: null, external_id: 'US-12' }, us)).toBe('https://jira.example.com/browse/US-12');
    expect(externalUrl({ url: 'https://x.test/1', external_id: 'US-12' }, us)).toBe('https://x.test/1');
    expect(externalUrl({ url: null, external_id: null }, us)).toBeNull();
    expect(externalUrl({ url: null, external_id: 'US-12' }, findType(DEFAULT_ITEM_TYPES, 'us'))).toBeNull();
  });
});

describe('configurar tipos', () => {
  it('crear un tipo con estados por defecto', async () => {
    const t = await repo.createItemType('Defecto');
    expect(t).toMatchObject({ name: 'Defecto', short: 'D' });
    expect(t.states.map((s) => s.category)).toEqual(['todo', 'doing', 'blocked', 'done']);
  });

  it('al quitar un estado, sus tareas pasan al equivalente', async () => {
    const task = await repo.createTask({ title: 'x', type_id: 'us' });
    await repo.setState(task.id, 'us-qa');
    const us = (await repo.listItemTypes()).find((t) => t.id === 'us')!;
    await repo.saveItemType({ ...us, states: us.states.filter((s) => s.id !== 'us-qa') });
    expect((await repo.getTask(task.id))?.state_id).toBe('us-dev'); // primer estado "doing"
    await repo.undo();
    expect((await repo.getTask(task.id))?.state_id).toBe('us-qa');
    expect((await repo.listItemTypes()).find((t) => t.id === 'us')!.states).toHaveLength(8);
  });

  it('"Accepted" cuenta como completada y se puede reabrir', async () => {
    const task = await repo.createTask({ title: 'x', type_id: 'us' });
    await repo.setState(task.id, 'us-accepted');
    expect(await repo.getTask(task.id)).toMatchObject({ status: 'done', state_id: 'us-accepted' });
    expect((await repo.getTask(task.id))?.completed_at).toBeTruthy();
    await repo.setState(task.id, 'us-dev');
    expect(await repo.getTask(task.id)).toMatchObject({ status: 'todo', state_id: 'us-dev', completed_at: null });
    // Al cambiar de tipo, una aceptada sigue aceptada (o completada si el tipo no tiene "Accepted").
    await repo.setState(task.id, 'us-accepted');
    await repo.setType(task.id, 'ts');
    expect(await repo.getTask(task.id)).toMatchObject({ status: 'done', state_id: 'ts-accepted' });
    await repo.setType(task.id, 'topic');
    expect(await repo.getTask(task.id)).toMatchObject({ status: 'done', state_id: 'topic-done' });
  });

  it('añade "Accepted" a los tipos de serie que no lo tienen, una sola vez', async () => {
    const strip = (t: ItemType) => ({ ...t, states: t.states.filter((s) => s.category !== 'accepted') });
    for (const t of await repo.listItemTypes()) await repo.saveItemType(strip(t));
    await repo.ensureAcceptedStates();
    await repo.ensureAcceptedStates();
    const types = await repo.listItemTypes();
    for (const id of ['task', 'us', 'ts']) {
      expect(types.find((t) => t.id === id)!.states.filter((s) => s.category === 'accepted').map((s) => s.name)).toEqual(['Accepted']);
    }
    expect(types.find((t) => t.id === 'topic')!.states.some((s) => s.category === 'accepted')).toBe(false);
    expect(withAcceptedState(types[0])).toBeNull();
  });

  it('eliminar un tipo pasa sus tareas a Tarea; Tarea no se puede eliminar', async () => {
    const task = await repo.createTask({ title: 'x', type_id: 'ts' });
    await repo.setState(task.id, 'ts-running');
    await repo.deleteItemType('ts');
    expect(await repo.getTask(task.id)).toMatchObject({ type_id: 'task', state_id: 'task-doing' });
    await repo.deleteItemType('task');
    expect((await repo.listItemTypes()).map((t) => t.id)).toEqual(['task', 'us', 'topic', 'fe', 'de', 'ds', 'ta']);
  });
});

describe('tipos de Rally', () => {
  it('una administradora añade los que faltan y las tareas con ID de Rally pasan a su tipo', async () => {
    for (const id of ['fe', 'de', 'ds', 'ta']) await repo.deleteItemType(id);
    const fe = await repo.createTask({ title: 'Feature', external_id: 'F12345' });
    const de = await repo.createTask({ title: 'Defecto', external_id: 'DE-77' });
    const tc = await repo.createTask({ title: 'Caso', external_id: 'TC1' });
    await repo.ensureRallyTypes(false);
    expect((await repo.getTask(fe.id))!.type_id).toBe('task');
    await repo.ensureRallyTypes(true);
    expect((await repo.listItemTypes()).map((t) => t.short)).toEqual(['', 'US', 'TS', 'HABLAR', 'FE', 'DE', 'DS', 'TA']);
    expect(await repo.getTask(fe.id)).toMatchObject({ type_id: 'fe', state_id: 'fe-todo' });
    expect((await repo.getTask(de.id))!.type_id).toBe('de');
    expect((await repo.getTask(tc.id))!.type_id).toBe('task');
  });
});
