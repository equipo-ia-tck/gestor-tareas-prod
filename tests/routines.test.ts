import { describe, expect, it } from 'vitest';
import { pendingRoutines, routineSeries, routineTask, TEAM_ROUTINES } from '../src/domain/routines';
import type { Task } from '../src/domain/types';

describe('rutinas del equipo', () => {
  it('solo crea las que no se han creado ni apuntado', () => {
    const tasks = [{ series_id: routineSeries('objetivos-semana') }] as Task[];
    expect(pendingRoutines(TEAM_ROUTINES, [], []).map((r) => r.id)).toEqual(['objetivos-semana', 'gestion-demanda']);
    expect(pendingRoutines(TEAM_ROUTINES, tasks, []).map((r) => r.id)).toEqual(['gestion-demanda']);
    expect(pendingRoutines(TEAM_ROUTINES, [], ['gestion-demanda']).map((r) => r.id)).toEqual(['objetivos-semana']);
  });
  it('la tarea es semanal en su día y empieza en la próxima fecha (hoy incluido)', () => {
    const [lunes, viernes] = TEAM_ROUTINES;
    // 17 nov 2026 es martes.
    expect(routineTask(lunes, '2026-11-17')).toMatchObject({ due_date: '2026-11-23', recurrence_rule: { freq: 'weekly', weekdays: [1] }, series_id: 'rutina:objetivos-semana' });
    expect(routineTask(viernes, '2026-11-20').due_date).toBe('2026-11-20');
  });
});

describe('rutinas: no se ven hasta su día', async () => {
  const { isHiddenRoutine } = await import('../src/domain/routines');
  const { nextOccurrenceTask } = await import('../src/domain/maintenance');
  const { makeTask } = await import('./factories');
  const rule = { freq: 'weekly' as const, interval: 1, weekdays: [1] };

  it('la del lunes siguiente queda oculta hasta ese lunes; las atrasadas y las de hoy se ven', () => {
    const t = makeTask({ series_id: 'rutina:objetivos-semana', due_date: '2026-11-23', recurrence_rule: rule });
    expect(isHiddenRoutine(t, '2026-11-16')).toBe(true);
    expect(isHiddenRoutine(t, '2026-11-23')).toBe(false);
    expect(isHiddenRoutine(t, '2026-11-25')).toBe(false);
    expect(isHiddenRoutine({ ...t, series_id: 'otra' }, '2026-11-16')).toBe(false);
    expect(isHiddenRoutine({ ...t, status: 'done' }, '2026-11-16')).toBe(false);
  });

  it('al completar la del lunes, la siguiente es el lunes que viene con aviso a las 9:00', () => {
    const t = makeTask({ series_id: 'rutina:objetivos-semana', due_date: '2026-11-16', recurrence_rule: rule });
    const next = nextOccurrenceTask(t, '2026-11-16')!;
    expect(next.due_date).toBe('2026-11-23');
    expect(new Date(next.remind_at!).getHours()).toBe(9);
    // Una recurrente que no es rutina no lleva aviso.
    expect(nextOccurrenceTask({ ...t, series_id: 'x' }, '2026-11-16')!.remind_at).toBeUndefined();
  });
});
