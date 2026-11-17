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
