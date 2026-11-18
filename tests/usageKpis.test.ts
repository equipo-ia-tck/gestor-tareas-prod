import { describe, expect, it } from 'vitest';
import type { Change } from '../src/data/repository';
import { historyActions, type UsageReport, type UsageSnapshot } from '../src/domain/usage';
import { screenKpis } from '../src/domain/usageKpis';

const snap = (extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  tasksCreated: 0, createdWithDate: 0, createdWithProject: 0, tasksActive: 0, activeWithDate: 0, activeWithProject: 0, rallyActive: 0,
  notesCreated: 0, notesTotal: 0, notesInSection: 0, sections: 0, projectsCreated: 0, tasksFromNotes: 0, tasksFromNotesDone: 0,
  groups: 0, peopleCards: 0, peopleInGroup: 0, peopleWithEmail: 0, peopleWithRole: 0, rallyConnected: false, lastReviewOn: null, ...extra,
});
const row = (user: string, kind: string, screen: string, extra: Record<string, unknown> = {}) =>
  ({ user, day: '2026-11-17', kind, screen, count: 1, last: '2026-11-17T10:00:00Z', name: '', detail: '', value: null, ...extra }) as UsageReport['rows'][number];

const report: UsageReport = {
  users: [
    { id: 'a', name: 'Ana', login: 'a', disabled: false, snapshot: snap({ rallyConnected: true, tasksActive: 4, activeWithDate: 3 }) },
    { id: 'b', name: 'Bea', login: 'b', disabled: false, snapshot: snap({ tasksActive: 6, activeWithDate: 1 }) },
  ],
  rows: [
    row('a', 'screen', 'board', { count: 4 }), row('a', 'quality', 'board', { count: 3 }), row('a', 'visit', 'board', { count: 5, value: 200 }),
    row('b', 'screen', 'board', { count: 1 }), row('b', 'visit', 'board', { value: 5 }),
    row('a', 'action', 'board', { name: 'state-change', count: 2, value: 2 }),
    row('b', 'action', 'project', { name: 'state-change', value: 1 }),
    row('a', 'action', 'board', { name: 'analyst', detail: 'yes', value: 1 }),
    row('b', 'action', 'board', { name: 'analyst', detail: 'no', value: 1 }),
    row('a', 'action', 'rally', { name: 'rally-add', detail: 'all.project', value: 7 }),
    row('b', 'action', 'calendar', { name: 'meeting-create', detail: 'dblclick', value: 1 }),
  ],
  states: [{ user: 'a', name: 'calendar-tasks', detail: '', value: 1, at: '' }, { user: 'b', name: 'calendar-tasks', detail: '', value: 0, at: '' }],
};
const find = (blocks: ReturnType<typeof screenKpis>, id: string, label: string) => blocks.find((b) => b.id === id)!.kpis.find((k) => k.label === label)!;

describe('KPIs de la analítica', () => {
  it('equipo: suma de todas las cuentas, con cuántas personas lo hacen', () => {
    const team = screenKpis(report, null);
    const board = team.find((b) => b.id === 'board')!;
    expect(board.visits).toEqual({ visits: 5, quality: 3, people: 2, qualityPeople: 1, avgSeconds: 41 });
    expect(find(team, 'board', 'Tareas movidas de estado en el tablero')).toMatchObject({ value: '2', people: { n: 1, of: 2 } });
    expect(find(team, 'project', 'Cambios de estado dentro de un proyecto').value).toBe('1');
    expect(find(team, 'board', 'Nombran analista al comentar un cambio de estado').value).toBe('50 %');
    expect(find(team, 'board', 'Pendientes con fecha').value).toBe('40 %');
    expect(find(team, 'rally', 'Tienen Rally conectado').value).toBe('1 de 2');
    expect(find(team, 'rally', 'Pasar a mis tareas del gestor').parts).toEqual([{ label: 'Todas de golpe', value: 7 }, { label: 'Con proyecto', value: 7 }]);
    expect(find(team, 'calendar', 'Tienen activado «Tareas» en el calendario').value).toBe('1 de 2');
    expect(find(team, 'calendar', 'Reuniones creadas').parts).toEqual([{ label: 'Doble clic en la hora', value: 1 }]);
  });

  it('persona: solo lo suyo y sin recuento de personas', () => {
    const bea = screenKpis(report, ['b']);
    expect(bea.find((b) => b.id === 'board')!.visits).toMatchObject({ visits: 1, quality: 0, avgSeconds: 5 });
    expect(find(bea, 'board', 'Tareas movidas de estado en el tablero')).toEqual({ label: 'Tareas movidas de estado en el tablero', value: '0' });
    expect(find(bea, 'rally', 'Tienen Rally conectado').value).toBe('No');
    expect(find(bea, 'calendar', 'Tienen activado «Tareas» en el calendario').value).toBe('No');
  });

  it('del historial: creadas y cambios de estado; los que trae Rally, aparte', () => {
    const t = { id: 't', state_id: 's1' } as never;
    const moved = { id: 't', state_id: 's2' } as never;
    const changes: Change[] = [
      { table: 'tasks', key: 'n', before: undefined, after: t },
      { table: 'tasks', key: 't', before: t, after: moved },
      { table: 'notes', key: 'x', before: undefined, after: { id: 'x', deleted_at: null } as never },
    ];
    expect(historyActions(changes, false)).toEqual([
      { name: 'task-create', detail: '', count: 1, auto: false },
      { name: 'state-change', detail: '', count: 1, auto: false },
      { name: 'note-create', detail: '', count: 1, auto: false },
    ]);
    expect(historyActions(changes, true)).toEqual([
      { name: 'rally-in', detail: '', count: 1, auto: true },
      { name: 'note-create', detail: '', count: 1, auto: false },
    ]);
  });
});
