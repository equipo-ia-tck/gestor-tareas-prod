import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseBackup } from '../src/data/backup';
import { TasksDB } from '../src/data/db';
import { DexieRepository } from '../src/data/repository';
import { labelColor, colorFor, initials } from '../src/domain/colors';
import { DEFAULT_ITEM_TYPES, equivalentState, findType, patchForState, stateOf } from '../src/domain/workflows';
import { DEFAULT_SETTINGS } from '../src/domain/types';

let repo: DexieRepository;
beforeEach(() => { repo = new DexieRepository(new TasksDB(`v2-${crypto.randomUUID()}`)); });

describe('migración v1 → v2', () => {
  it('conserva las tareas y les asigna tipo, estado y pasos', async () => {
    const name = `mig-${crypto.randomUUID()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({ projects: 'id', tasks: 'id, status', settings: 'key', meta: 'key' });
    await v1.table('tasks').bulkAdd([
      { id: 'a', title: 'pendiente', status: 'todo', tags: [], people: [] },
      { id: 'b', title: 'hecha', status: 'done', tags: [], people: [] },
    ]);
    v1.close();

    const db = new TasksDB(name);
    const tasks = await db.tasks.toArray();
    expect(tasks.find((t) => t.id === 'a')).toMatchObject({ type_id: 'task', state_id: 'task-todo', checklist: [] });
    expect(tasks.find((t) => t.id === 'b')).toMatchObject({ state_id: 'task-done' });
    expect((await db.item_types.toArray()).map((t) => t.id).sort()).toEqual(['de', 'ds', 'fe', 'ta', 'task', 'topic', 'ts', 'us']);
  });

  it('una base de datos nueva trae los tipos por defecto', async () => {
    expect((await repo.listItemTypes()).map((t) => t.short)).toEqual(['', 'US', 'TS', 'HABLAR', 'FE', 'DE', 'DS', 'TA']);
  });
});

describe('estados y tipos', () => {
  it('crear una tarea le pone el estado inicial de su tipo', async () => {
    expect(await repo.createTask({ title: 'a' })).toMatchObject({ type_id: 'task', state_id: 'task-todo' });
    expect(await repo.createTask({ title: 'b', type_id: 'us' })).toMatchObject({ type_id: 'us', state_id: 'us-backlog' });
  });

  it('completar y reabrir sincronizan el estado', async () => {
    const t = await repo.createTask({ title: 'a', type_id: 'ts' });
    await repo.setCompleted(t.id, true);
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'done', state_id: 'ts-passed' });
    await repo.setCompleted(t.id, false);
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'todo', state_id: 'ts-todo' });
  });

  it('mover a un estado "hecho" completa; salir de él reabre', async () => {
    const t = await repo.createTask({ title: 'a', type_id: 'us' });
    await repo.setState(t.id, 'us-qa');
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'todo', state_id: 'us-qa' });
    await repo.setState(t.id, 'us-prod');
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'done', state_id: 'us-prod' });
    await repo.setState(t.id, 'us-dev');
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'todo', state_id: 'us-dev', completed_at: null });
  });

  it('pasar una recurrente a "hecho" desde el tablero crea la siguiente', async () => {
    const t = await repo.createTask({ title: 'r', recurrence_rule: { freq: 'daily', interval: 1 } });
    await repo.setState(t.id, 'task-done');
    expect(await repo.listTasks()).toHaveLength(2);
    await repo.undo();
    expect(await repo.listTasks()).toHaveLength(1);
  });

  it('cambiar de tipo conserva la categoría del estado', async () => {
    const t = await repo.createTask({ title: 'a' });
    await repo.setState(t.id, 'task-doing');
    await repo.setType(t.id, 'ts');
    expect(await repo.getTask(t.id)).toMatchObject({ type_id: 'ts', state_id: 'ts-running' });
  });

  it('funciones puras de flujo', () => {
    const us = findType(DEFAULT_ITEM_TYPES, 'us');
    expect(findType(DEFAULT_ITEM_TYPES, 'no-existe').id).toBe('task');
    expect(stateOf(DEFAULT_ITEM_TYPES, { type_id: 'us', state_id: 'raro', status: 'done' }).id).toBe('us-prod');
    expect(equivalentState(us.states[4], findType(DEFAULT_ITEM_TYPES, 'task')).id).toBe('task-blocked');
    expect(patchForState({ status: 'todo', completed_at: null }, us.states[6], 'T')).toEqual({ state_id: 'us-prod', status: 'done', completed_at: 'T' });
    expect(patchForState({ status: 'todo', completed_at: null }, us.states[2], 'T')).toEqual({ state_id: 'us-dev' });
  });
});

describe('etiquetas', () => {
  it('color propio, renombrar y eliminar (con deshacer)', async () => {
    const t = await repo.createTask({ title: 'a', tags: ['Urgente', 'casa'] });
    await repo.setLabelColor('urgente', '#000000');
    expect(await repo.listLabels()).toEqual([{ name: 'urgente', color: '#000000' }]);

    await repo.renameLabel('urgente', 'crítico');
    expect((await repo.getTask(t.id))?.tags).toEqual(['crítico', 'casa']);
    expect(await repo.listLabels()).toEqual([{ name: 'crítico', color: '#000000' }]);

    await repo.deleteLabel('crítico');
    expect((await repo.getTask(t.id))?.tags).toEqual(['casa']);
    expect(await repo.listLabels()).toEqual([]);

    await repo.undo();
    expect((await repo.getTask(t.id))?.tags).toEqual(['crítico', 'casa']);
    expect(await repo.listLabels()).toHaveLength(1);
  });

  it('colores derivados estables e iniciales', () => {
    expect(colorFor('Diana')).toBe(colorFor('diana'));
    expect(labelColor('casa', [{ name: 'Casa', color: '#123456' }])).toBe('#123456');
    expect(initials('Ana María López')).toBe('AM');
    expect(initials('diana')).toBe('D');
  });
});

describe('copias', () => {
  it('importa copias v1 completando los campos nuevos', () => {
    const v1 = {
      app: 'gestor-tareas', schema_version: 1, exported_at: '2026-10-05T10:00:00Z', projects: [], settings: DEFAULT_SETTINGS,
      tasks: [{
        id: 't', project_id: null, title: 'x', notes: '', due_date: null, priority: 4, estimated_minutes: null,
        people: [], tags: [], status: 'done', recurrence_rule: null, series_id: null, sort_order: 0, raw_input: '',
        created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z',
        last_touched_at: '2026-10-01T00:00:00Z', deleted_at: null,
      }],
    };
    const r = parseBackup(JSON.stringify(v1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup.tasks[0]).toMatchObject({ type_id: 'task', state_id: 'task-done', checklist: [] });
    expect(r.backup.item_types).toHaveLength(8);
    expect(r.backup.labels).toEqual([]);
  });

  it('exporta e importa tipos y etiquetas', async () => {
    await repo.setLabelColor('casa', '#111111');
    const snap = await repo.exportSnapshot();
    expect(snap.schema_version).toBe(7);
    const other = new DexieRepository(new TasksDB(`v2-${crypto.randomUUID()}`));
    const r = parseBackup(JSON.stringify(snap));
    if (r.ok) await other.replaceAll(r.backup);
    expect(await other.listLabels()).toEqual([{ name: 'casa', color: '#111111' }]);
    expect(await other.listItemTypes()).toHaveLength(8);
  });
});
