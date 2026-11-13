import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksDB } from '../src/data/db';
import { DexieRepository } from '../src/data/repository';
import { parseBackup } from '../src/data/backup';
import { todayISO } from '../src/domain/dates';

let repo: DexieRepository;

beforeEach(() => {
  repo = new DexieRepository(new TasksDB(`test-${crypto.randomUUID()}`));
});

describe('DexieRepository', () => {
  it('crea tareas con valores por defecto y guarda el texto original', async () => {
    const t = await repo.createTask({ title: '  llamar al dentista ' });
    expect(t).toMatchObject({ title: 'llamar al dentista', priority: 4, status: 'todo', project_id: null });
    expect(t.raw_input).toBe('  llamar al dentista ');
    expect(await repo.listTasks()).toHaveLength(1);
  });

  it('actualiza last_touched_at al editar', async () => {
    const t = await repo.createTask({ title: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const u = await repo.updateTask(t.id, { title: 'b' });
    expect(u?.title).toBe('b');
    expect(u!.last_touched_at > t.last_touched_at).toBe(true);
  });

  it('mete a una persona en un grupo sin perder su ficha y se puede deshacer', async () => {
    await repo.savePerson({ name: 'Diana', role: 'QA', notes: '', email: 'd@x.es' });
    await repo.batch('Movida a QA', () => repo.setPersonGroup('diana', 'g1'));
    expect(await repo.listPeople()).toEqual([{ name: 'Diana', role: 'QA', notes: '', email: 'd@x.es', group_id: 'g1' }]);
    await repo.savePerson({ name: 'Diana', role: 'Lead QA', notes: '', email: 'd@x.es' });
    expect((await repo.listPeople())[0]).toMatchObject({ role: 'Lead QA', group_id: 'g1' });
    await repo.undo();
    await repo.undo();
    expect((await repo.listPeople())[0].group_id).toBeUndefined();
    await repo.setPersonGroup('Luis', 'g2');
    expect((await repo.listPeople()).find((p) => p.name === 'Luis')).toMatchObject({ role: '', group_id: 'g2' });
  });

  it('completa y descompleta', async () => {
    const t = await repo.createTask({ title: 'a' });
    await repo.setCompleted(t.id, true);
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'done' });
    expect((await repo.getTask(t.id))?.completed_at).not.toBeNull();
    await repo.setCompleted(t.id, false);
    expect(await repo.getTask(t.id)).toMatchObject({ status: 'todo', completed_at: null });
  });

  it('borra de forma suave, restaura y purga', async () => {
    const t = await repo.createTask({ title: 'a' });
    await repo.deleteTask(t.id);
    expect(await repo.listTasks()).toHaveLength(0);
    await repo.restoreTask(t.id);
    expect(await repo.listTasks()).toHaveLength(1);
    await repo.deleteTask(t.id);
    expect(await repo.purgeDeleted(30)).toBe(0);
    expect(await repo.purgeDeleted(-1)).toBe(1);
    expect(await repo.getTask(t.id)).toBeUndefined();
  });

  it('gestiona proyectos y archivados', async () => {
    const p = await repo.createProject('caixa');
    await repo.createProject('alfa');
    expect((await repo.listProjects()).map((x) => x.name)).toEqual(['alfa', 'caixa']);
    await repo.updateProject(p.id, { archived: true });
    expect(await repo.listProjects()).toHaveLength(1);
    expect(await repo.listProjects(true)).toHaveLength(2);
  });

  it('devuelve ajustes por defecto y los fusiona', async () => {
    expect((await repo.getSettings()).capacity_minutes).toBe(360);
    await repo.updateSettings({ capacity_minutes: 300 });
    const s = await repo.getSettings();
    expect(s.capacity_minutes).toBe(300);
    expect(s.workdays).toEqual([1, 2, 3, 4, 5]);
  });

  it('avisa de los cambios, salvo al registrar una copia', async () => {
    const spy = vi.fn();
    repo.onChange(spy);
    await repo.createTask({ title: 'a' });
    expect(spy).toHaveBeenCalledTimes(1);
    await repo.markBackup();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await repo.getSettings()).last_backup_at).not.toBeNull();
  });

  it('exporta e importa sin pérdidas (ida y vuelta)', async () => {
    const p = await repo.createProject('caixa');
    await repo.createTask({ title: 'a', project_id: p.id, people: ['Diana'], due_date: '2026-10-06' });
    await repo.createTask({ title: 'b' });
    const snapshot = await repo.exportSnapshot();
    const parsed = parseBackup(JSON.stringify(snapshot));
    expect(parsed.ok).toBe(true);

    const other = new DexieRepository(new TasksDB(`test-${crypto.randomUUID()}`));
    await other.createTask({ title: 'se sobrescribe' });
    if (parsed.ok) await other.replaceAll(parsed.backup);
    const tasks = await other.listTasks();
    expect(tasks.map((t) => t.title).sort()).toEqual(['a', 'b']);
    expect(await other.listProjects()).toHaveLength(1);
  });
});

describe('historial (deshacer / rehacer)', () => {
  it('deshace y rehace una creación', async () => {
    const t = await repo.createTask({ title: 'a' });
    expect((await repo.undo())?.label).toBe('Tarea creada');
    expect(await repo.getTask(t.id)).toBeUndefined();
    await repo.redo();
    expect((await repo.getTask(t.id))?.title).toBe('a');
  });

  it('deshace ediciones, completados y borrados en orden', async () => {
    const t = await repo.createTask({ title: 'a' });
    await repo.updateTask(t.id, { title: 'b' });
    await repo.setCompleted(t.id, true);
    await repo.deleteTask(t.id);
    expect(await repo.listTasks()).toHaveLength(0);
    await repo.undo();
    expect((await repo.getTask(t.id))?.status).toBe('done');
    await repo.undo();
    expect((await repo.getTask(t.id))?.status).toBe('todo');
    await repo.undo();
    expect((await repo.getTask(t.id))?.title).toBe('a');
  });

  it('agrupa un lote en una sola entrada, incluidos los proyectos creados', async () => {
    await repo.batch('Captura', async () => {
      const p = await repo.createProject('nuevo');
      await repo.createTask({ title: 'x', project_id: p.id });
      await repo.createTask({ title: 'y' });
    });
    expect(await repo.listTasks()).toHaveLength(2);
    expect((await repo.undo())?.label).toBe('Captura');
    expect(await repo.listTasks()).toHaveLength(0);
    expect(await repo.listProjects()).toHaveLength(0);
    expect(await repo.undo()).toBeNull();
  });

  it('un cambio nuevo vacía la pila de rehacer', async () => {
    const t = await repo.createTask({ title: 'a' });
    await repo.updateTask(t.id, { title: 'b' });
    await repo.undo();
    await repo.updateTask(t.id, { title: 'c' });
    expect(await repo.redo()).toBeNull();
  });

  it('notifica cada entrada nueva y cada deshacer', async () => {
    const events: string[] = [];
    repo.onHistory((e) => events.push(`${e.type}:${e.entry.label}`));
    const t = await repo.createTask({ title: 'a' });
    await repo.batch('Mover', () => repo.updateTask(t.id, { due_date: '2026-10-06' }));
    await repo.undo();
    await repo.redo();
    expect(events).toEqual(['push:Tarea creada', 'push:Mover', 'undo:Mover', 'redo:Mover']);
  });

  it('importar vacía el historial', async () => {
    await repo.createTask({ title: 'a' });
    await repo.replaceAll(await repo.exportSnapshot());
    expect(await repo.undo()).toBeNull();
  });
});

describe('recurrentes', () => {
  it('completar una recurrente crea la siguiente y deshacer lo revierte todo', async () => {
    const t = await repo.createTask({
      title: 'regar', due_date: '2020-01-01', recurrence_rule: { freq: 'daily', interval: 1 }, series_id: 's1',
    });
    await repo.setCompleted(t.id, true);
    const all = await repo.listTasks();
    expect(all).toHaveLength(2);
    const next = all.find((x) => x.id !== t.id)!;
    expect(next).toMatchObject({ title: 'regar', status: 'todo', series_id: 's1' });
    expect(next.due_date! >= todayISO()).toBe(true);
    await repo.undo();
    expect(await repo.listTasks()).toHaveLength(1);
    expect((await repo.getTask(t.id))?.status).toBe('todo');
  });

  it('volver a marcar como pendiente no crea otra ocurrencia', async () => {
    const t = await repo.createTask({ title: 'x', recurrence_rule: { freq: 'daily', interval: 1 } });
    await repo.setCompleted(t.id, true);
    await repo.setCompleted(t.id, false);
    await repo.setCompleted(t.id, true);
    expect(await repo.listTasks()).toHaveLength(2);
  });
});

describe('Añadir desde archivo (mergeBackup)', () => {
  const file = (over: object = {}) => parseBackup(JSON.stringify({
    app: 'gestor-tareas', schema_version: 7, exported_at: '2026-10-13T08:00:00.000Z', settings: {},
    projects: [
      { id: 'p1', name: 'Pagos', color: '#16a34a', parent_id: null, archived: false, created_at: '2026-10-13T08:00:00.000Z' },
      { id: 'p2', name: 'Bizum', color: '#16a34a', parent_id: 'p1', archived: false, created_at: '2026-10-13T08:00:00.000Z' },
    ],
    tasks: [
      { id: 't1', project_id: 'p2', title: 'Alta Bizum', due_date: null, priority: 1, estimated_minutes: null, status: 'todo',
        type_id: 'us', state_id: 'us-qa', external_id: 'US1764574', people: ['Mike'],
        created_at: '2026-10-13T08:00:00.000Z', updated_at: '2026-10-13T08:00:00.000Z', completed_at: null, last_touched_at: '2026-10-13T08:00:00.000Z' },
    ],
    notes: [{ id: 'n1', title: 'Bizum', body: 'Con @Mike', kind: 'note', date: '2026-09-28', project_id: 'p1', task_id: null,
      created_at: '2026-09-28T12:00:00.000Z', updated_at: '2026-09-28T12:00:00.000Z' }],
    people: [{ name: 'Mike', role: 'Valida las US' }],
    ...over,
  }));

  it('suma sin borrar, reutiliza proyectos y personas y se deshace de una vez', async () => {
    const mine = await repo.createTask({ title: 'mía' });
    const pagos = await repo.createProject('pagos');
    await repo.savePerson({ name: 'mike', role: '', notes: 'ya estaba', email: '' });
    const parsed = file();
    if (!parsed.ok) throw new Error(parsed.error);

    const r = await repo.mergeBackup(parsed.backup);
    expect(r).toMatchObject({ projects: 1, tasks: 1, notes: 1, people: 0 });
    const tasks = await repo.listTasks();
    expect(tasks.map((t) => t.id)).toContain(mine.id);
    const us = tasks.find((t) => t.external_id === 'US1764574')!;
    expect(us).toMatchObject({ type_id: 'us', state_id: 'us-qa' });
    const bizum = (await repo.listProjects()).find((p) => p.name === 'Bizum')!;
    expect(bizum.parent_id).toBe(pagos.id);
    expect(us.project_id).toBe(bizum.id);
    expect(await repo.listPeople()).toEqual([{ name: 'mike', role: 'Valida las US', notes: 'ya estaba', email: '' }]);

    // Importar otra vez no duplica nada.
    expect(await repo.mergeBackup(parsed.backup)).toMatchObject({ projects: 0, tasks: 0, notes: 0, skipped: 2 });

    await repo.undo();
    await repo.undo();
    expect((await repo.listTasks()).map((t) => t.id)).toEqual([mine.id]);
    expect(await repo.listNotes()).toHaveLength(0);
  });
});

describe('tareas con un espacio elegido en el filtro', () => {
  it('sin proyecto van al proyecto del espacio (que se crea una vez)', async () => {
    repo.defaultSpaceId = 'esp-1';
    repo.defaultSpace = { id: 'esp-1', name: 'AI Geeks', color: '#10b981' };
    const a = await repo.createTask({ title: 'una' });
    const b = await repo.createTask({ title: 'otra' });
    const projects = await repo.db.projects.toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: 'AI Geeks', space_id: 'esp-1', color: '#10b981', parent_id: null });
    expect(a.project_id).toBe(projects[0].id);
    expect(b.project_id).toBe(projects[0].id);
  });

  it('con proyecto o sin espacio elegido no cambia nada', async () => {
    const own = await repo.createProject('Mío', { space_id: null });
    repo.defaultSpace = { id: 'esp-1', name: 'AI Geeks', color: '#10b981' };
    expect((await repo.createTask({ title: 'x', project_id: own.id })).project_id).toBe(own.id);
    repo.defaultSpace = null;
    expect((await repo.createTask({ title: 'y' })).project_id).toBeNull();
  });

  it('un solo deshacer quita la tarea y el proyecto creado', async () => {
    repo.defaultSpace = { id: 'esp-1', name: 'AI Geeks', color: '#10b981' };
    await repo.createTask({ title: 'una' });
    await repo.undo();
    expect(await repo.db.projects.count()).toBe(0);
    expect(await repo.db.tasks.count()).toBe(0);
  });
});

describe('eliminar proyectos', () => {
  it('borra el proyecto y sus subproyectos, elimina sus tareas, deja sus notas sin sección y se puede deshacer', async () => {
    const p = await repo.createProject('Pagos', { space_id: null });
    const sub = await repo.createProject('Bizum', { parent_id: p.id });
    const other = await repo.createProject('Otro', { space_id: null });
    const t1 = await repo.createTask({ title: 'a', project_id: p.id });
    const t2 = await repo.createTask({ title: 'b', project_id: sub.id });
    const t3 = await repo.createTask({ title: 'c', project_id: other.id });
    const n = await repo.createNote({ date: '2026-11-12', body: 'acta', project_id: sub.id });
    expect(await repo.deleteProject(p.id)).toEqual({ tasks: 2, notes: 1 });
    expect((await repo.db.projects.toArray()).map((x) => x.name)).toEqual(['Otro']);
    expect((await repo.listTasks()).map((t) => t.id)).toEqual([t3.id]);
    expect((await repo.getNote(n.id))?.project_id).toBeNull();
    await repo.undo();
    expect((await repo.db.projects.count())).toBe(3);
    expect((await repo.listTasks()).map((t) => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
    expect((await repo.getNote(n.id))?.project_id).toBe(sub.id);
  });
});
