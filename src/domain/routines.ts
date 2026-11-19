import { firstOccurrence } from './recurrence';
import type { ISODate, NewTask, RecurrenceRule, Task } from './types';

/**
 * Rutinas del equipo: tareas que se repiten y que todo el mundo tiene (petición de Stephannie, nov 2026). La primera vez que
 * alguien abre la app se le crean como tareas recurrentes suyas; si las borra, no vuelven (`settings.routines_added`).
 * Para cambiar el texto o el enlace, se edita aquí (vale para las cuentas que aún no la tienen; las ya creadas son tareas
 * normales y se editan en su panel).
 */
export interface TeamRoutine {
  id: string;
  title: string;
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
  /** Enlace directo (se abre desde la tarea). */
  url: string | null;
  notes: string;
}

export const TEAM_ROUTINES: TeamRoutine[] = [
  {
    id: 'objetivos-semana',
    title: 'Rellenar los objetivos de la semana y enviar el correo de planificación semanal',
    weekday: 1,
    url: null,
    notes: 'Cada lunes: rellenar el objetivo semanal y enviar el correo de planificación semanal.',
  },
  {
    id: 'gestion-demanda',
    title: 'Rellenar la gestión de la demanda',
    weekday: 5,
    url: null,
    notes: 'Cada viernes: rellenar la gestión de la demanda.',
  },
];

export const routineSeries = (id: string) => `rutina:${id}`;

/** Rutinas que aún hay que crear: ni apuntadas en los ajustes ni con alguna tarea de su serie (aunque esté borrada). */
export function pendingRoutines(routines: TeamRoutine[], tasks: Task[], added: string[]): TeamRoutine[] {
  const series = new Set(tasks.map((t) => t.series_id));
  return routines.filter((r) => !added.includes(r.id) && !series.has(routineSeries(r.id)));
}

/** Tarea de una rutina: semanal en su día, con la primera fecha desde hoy (incluido). */
export function routineTask(r: TeamRoutine, today: ISODate): NewTask {
  const rule: RecurrenceRule = { freq: 'weekly', interval: 1, weekdays: [r.weekday] };
  return {
    title: r.title,
    notes: r.notes,
    url: r.url,
    recurrence_rule: rule,
    series_id: routineSeries(r.id),
    due_date: firstOccurrence(rule, today),
    priority: 2,
    tags: ['rutina'],
  };
}

/** Tarea de una rutina del equipo (por su serie `rutina:<id>`). */
export const isRoutine = (t: Pick<Task, 'series_id'>) => !!t.series_id?.startsWith('rutina:');

/**
 * La siguiente ocurrencia de una rutina no se ve hasta su día: al completar la del lunes, la del lunes siguiente queda
 * oculta toda la semana (si estuviera siempre a la vista, se dejaría de hacer caso). Las atrasadas sí se ven.
 */
export const isHiddenRoutine = (t: Task, today: ISODate) =>
  isRoutine(t) && t.status === 'todo' && !t.deleted_at && !!t.due_date && t.due_date > today;

/** Hora del aviso de una rutina el día que toca (la app avisa si está abierta). */
export const ROUTINE_REMIND_HOUR = 9;
