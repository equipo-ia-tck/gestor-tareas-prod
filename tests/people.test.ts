import { describe, expect, it } from 'vitest';
import { boardPeople, groupOf, groupPeople, peopleDirectory } from '../src/domain/people';
import { rallyOwners } from '../src/domain/rally';
import type { Note } from '../src/domain/types';
import { makeTask } from './factories';

const note = (people: string[]): Note => ({
  id: crypto.randomUUID(), title: '', body: '', kind: 'note', date: '2026-10-08', project_id: null, people, pinned: false,
  task_id: null, meeting_url: null, sort_order: null, created_at: '', updated_at: '', deleted_at: null,
});

describe('directorio de personas', () => {
  it('une tareas, menciones en notas y fichas', () => {
    const dir = peopleDirectory(
      [makeTask({ people: ['Diana'] }), makeTask({ people: ['diana', 'Luis'] }), makeTask({ people: ['Luis'], status: 'done' })],
      [note(['Diana']), note(['Marcos Porto']), note(['marcos porto', 'Ana'])],
      [{ name: 'Ana López', role: '', notes: '', email: '' }, { name: 'Luis', role: 'Dev', notes: '', email: '' }],
    );
    expect(dir).toEqual([
      { name: 'Diana', tasks: 2, notes: 1, rally: 0 },
      { name: 'Luis', tasks: 1, notes: 0, rally: 0 },
      { name: 'Marcos Porto', tasks: 0, notes: 2, rally: 0 },
      { name: 'Ana', tasks: 0, notes: 1, rally: 0 },
      { name: 'Ana López', tasks: 0, notes: 0, rally: 0 },
    ]);
  });

  it('añade a los Owners de Rally de las tareas enlazadas, sin contar dos veces', () => {
    const tasks = [
      makeTask({ external_id: 'US-1' }),
      makeTask({ external_id: 'US2', people: ['Carla Ruiz'] }),
      makeTask({ external_id: 'US3', status: 'done' }),
      makeTask({ external_id: 'US4' }),
      makeTask({ external_id: 'otra-cosa' }),
      makeTask({ external_id: 'US5', deleted_at: '2026-10-01T00:00:00Z' }),
    ];
    const owners: Record<string, string> = { US1: 'Carla Ruiz', US2: 'carla ruiz', US3: 'Elena', US4: 'Elena', US5: 'Borrada' };
    const map = rallyOwners(tasks, (id) => owners[id]);
    expect([...map.values()]).toEqual(['Carla Ruiz', 'carla ruiz', 'Elena', 'Elena']);
    expect(peopleDirectory(tasks, [], [], map)).toEqual([
      { name: 'Carla Ruiz', tasks: 1, notes: 0, rally: 1 },
      { name: 'Elena', tasks: 0, notes: 0, rally: 1 },
    ]);
  });
});

describe('renombrar y unir personas', async () => {
  const { renameInList, renameMentions } = await import('../src/domain/people');
  const { TasksDB } = await import('../src/data/db');
  const { DexieRepository } = await import('../src/data/repository');

  it('menciones y listas', () => {
    expect(renameMentions('hablar con @Diana-Pérez y @diana-perez; @Luis', 'Diana Pérez', 'Diana')).toBe('hablar con @Diana y @Diana; @Luis');
    expect(renameInList(['Diana Pérez', 'Diana', 'Luis'], 'Diana Pérez', 'Diana')).toEqual(['Diana', 'Luis']);
  });

  it('une a dos personas en tareas, notas y fichas, y se puede deshacer', async () => {
    const repo = new DexieRepository(new TasksDB(`ppl-${crypto.randomUUID()}`));
    const t = await repo.createTask({ title: 'x', people: ['Diana Pérez', 'Luis'] });
    const n = await repo.createNote({ date: '2026-10-08', body: '@Diana-Pérez pide la demo' });
    await repo.savePerson({ name: 'Diana Pérez', role: '', notes: 'del calendario', email: 'diana@empresa.com' });
    await repo.savePerson({ name: 'Diana', role: 'PO', notes: '', email: '' });
    await repo.renamePerson('Diana Pérez', 'Diana');
    expect((await repo.getTask(t.id))?.people).toEqual(['Diana', 'Luis']);
    expect((await repo.getNote(n.id))?.body).toBe('@Diana pide la demo');
    expect((await repo.getNote(n.id))?.people).toEqual(['Diana']);
    expect(await repo.listPeople()).toEqual([{ name: 'Diana', role: 'PO', notes: 'del calendario', email: 'diana@empresa.com' }]);
    await repo.undo();
    expect((await repo.getTask(t.id))?.people).toEqual(['Diana Pérez', 'Luis']);
    expect((await repo.listPeople()).map((p) => p.name).sort()).toEqual(['Diana', 'Diana Pérez']);
  });

  it('al unir, usa el nombre que ya existe aunque se escriba distinto (sin dos «Diana»)', async () => {
    const repo = new DexieRepository(new TasksDB(`ppl-${crypto.randomUUID()}`));
    const a = await repo.createTask({ title: 'a', people: ['Diana Pérez', 'Diana'] });
    const b = await repo.createTask({ title: 'b', people: ['Luis'] });
    await repo.savePerson({ name: 'Diana', role: 'PO', notes: '', email: '', group_id: 'g1' });
    await repo.savePerson({ name: 'Diana Pérez', role: '', notes: 'vieja', email: 'd@x.com' });
    expect(await repo.renamePerson('Diana Pérez', 'diana')).toBe('Diana');
    expect((await repo.getTask(a.id))?.people).toEqual(['Diana']);
    expect((await repo.getTask(b.id))?.people).toEqual(['Luis']);
    expect(await repo.listPeople()).toEqual([{ name: 'Diana', role: 'PO', notes: 'vieja', email: 'd@x.com', group_id: 'g1' }]);
    // Solo cambiar mayúsculas de una persona sin otra con ese nombre.
    expect(await repo.renamePerson('Luis', 'LUIS')).toBe('LUIS');
    expect((await repo.getTask(b.id))?.people).toEqual(['LUIS']);
  });

  it('eliminar persona: sale de tareas y menciones, se borra la ficha y se puede deshacer', async () => {
    const { dropMentions } = await import('../src/domain/people');
    expect(dropMentions('hablar con @Diana-Pérez y @Luis', 'Diana Pérez')).toBe('hablar con Diana Pérez y @Luis');
    const repo = new DexieRepository(new TasksDB(`ppl-${crypto.randomUUID()}`));
    const t = await repo.createTask({ title: 'x', people: ['Diana Pérez', 'Luis'] });
    const n = await repo.createNote({ date: '2026-10-08', body: '@Diana-Pérez pide la demo a @Luis' });
    await repo.savePerson({ name: 'Diana Pérez', role: 'PO', notes: '', email: '' });
    expect(await repo.deletePerson('diana perez')).toBe(1);
    expect((await repo.getTask(t.id))?.people).toEqual(['Luis']);
    expect((await repo.getNote(n.id))?.body).toBe('diana perez pide la demo a @Luis');
    expect((await repo.getNote(n.id))?.people).toEqual(['Luis']);
    expect(await repo.listPeople()).toEqual([]);
    await repo.undo();
    expect((await repo.getTask(t.id))?.people).toEqual(['Diana Pérez', 'Luis']);
    expect((await repo.listPeople()).map((p) => p.name)).toEqual(['Diana Pérez']);
  });
});

describe('grupos de personas', () => {
  const groups = [{ id: 'g1', name: 'QA', color: '#f00' }, { id: 'g2', name: 'Cliente', color: '#0f0' }, { id: 'g3', name: 'Vacío', color: '#00f' }];
  const cards = [
    { name: 'Diana', role: '', notes: '', email: '', group_id: 'g2' },
    { name: 'Luis Pérez', role: '', notes: '', email: '', group_id: 'g1' },
    { name: 'Ana', role: '', notes: '', email: '', group_id: 'borrado' },
  ];

  it('reparte en el orden de los grupos, con los vacíos y "Sin grupo" al final', () => {
    const people = [{ name: 'diana' }, { name: 'Marcos' }, { name: 'luis-perez' }, { name: 'Ana' }];
    expect(groupPeople(people, cards, groups).map((s) => [s.group?.name ?? null, s.people.map((p) => p.name)])).toEqual([
      ['QA', ['luis-perez']],
      ['Cliente', ['diana']],
      ['Vacío', []],
      [null, ['Marcos', 'Ana']],
    ]);
  });

  it('sin nadie sin grupo no añade la sección', () => {
    expect(groupPeople([{ name: 'Diana' }], cards, groups).some((s) => s.group === null)).toBe(false);
  });

  it('un grupo que ya no existe cuenta como sin grupo', () => {
    expect(groupOf('Ana', cards, groups)).toBeNull();
    expect(groupOf('DIANA', cards, groups)?.name).toBe('Cliente');
  });
});

describe('personas del tablero de un proyecto', () => {
  it('junta personas y Owners de Rally de las pendientes, sin repetir', () => {
    const a = makeTask({ people: ['Diana', 'Luis'] });
    const b = makeTask({ people: ['diana'], external_id: 'US-1' });
    const c = makeTask({ people: ['Ana'], status: 'done' });
    const owners = new Map([[b.id, 'Pepa PO'], [a.id, 'Diana']]);
    expect(boardPeople([a, b, c], (id) => owners.get(id))).toEqual([
      { name: 'Diana', taskIds: [a.id, b.id] },
      { name: 'Luis', taskIds: [a.id] },
      { name: 'Pepa PO', taskIds: [b.id] },
    ]);
  });
});
