import { addDays, diffDays, nextWorkdays, weekdayOf } from './dates';
import { nextDueAfterCompletion } from './recurrence';
import { atLocal } from './reminders';
import { isRoutine, ROUTINE_REMIND_HOUR } from './routines';
import { isActive, overdueTasks, tasksDueOn } from './selectors';
import type { ISODate, NewTask, Settings, Task } from './types';

/** Las tareas sin estimación cuentan esto al repartir. */
export const DEFAULT_ESTIMATE_MINUTES = 30;
/** Días sin tocar a partir de los cuales una tarea se propone para archivar. */
export const STALE_DAYS = 30;
/** Hasta cuántos días laborables se reparte como máximo. */
const DISTRIBUTE_HORIZON = 30;

const estimate = (t: Task) => t.estimated_minutes ?? DEFAULT_ESTIMATE_MINUTES;

/** Próximo lunes estrictamente posterior a hoy ("la semana que viene"). */
export function nextMonday(today: ISODate): ISODate {
  const diff = (8 - weekdayOf(today)) % 7 || 7;
  return addDays(today, diff);
}

/** Copia de una recurrente completada para su siguiente ocurrencia. */
export function nextOccurrenceTask(task: Task, today: ISODate): NewTask | null {
  if (!task.recurrence_rule) return null;
  const due = nextDueAfterCompletion(task.recurrence_rule, task.due_date, today);
  return {
    title: task.title,
    notes: task.notes,
    project_id: task.project_id,
    priority: task.priority,
    estimated_minutes: task.estimated_minutes,
    people: [...task.people],
    tags: [...task.tags],
    recurrence_rule: task.recurrence_rule,
    type_id: task.type_id,
    // Los pasos se repiten sin marcar.
    checklist: task.checklist.map((c) => ({ ...c, id: crypto.randomUUID(), done: false })),
    series_id: task.series_id ?? task.id,
    raw_input: task.raw_input,
    due_date: due,
    // Rutinas del equipo: aviso a las 9:00 del día en que vuelven a salir.
    ...(isRoutine(task) && due ? { remind_at: atLocal(due, ROUTINE_REMIND_HOUR) } : {}),
  };
}

/** Prioridad (1 primero) y, a igualdad, la que más tiempo lleva atrasada. */
export function compareByUrgency(a: Task, b: Task): number {
  return (
    a.priority - b.priority ||
    (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
    a.created_at.localeCompare(b.created_at)
  );
}

export interface Assignment {
  task: Task;
  date: ISODate;
}

/**
 * Reparte las atrasadas en los próximos días laborables (desde hoy si lo es) sin superar la
 * capacidad diaria, contando lo que ya hay previsto cada día. Una tarea más grande que la
 * capacidad libre de cualquier día va al día con más hueco.
 */
export function distributeOverdue(tasks: Task[], today: ISODate, settings: Settings): Assignment[] {
  const pending = overdueTasks(tasks, today).sort(compareByUrgency);
  const days = nextWorkdays(today, DISTRIBUTE_HORIZON, settings.workdays);
  if (!pending.length || !days.length) return [];
  const free = new Map(days.map((d) => [d, settings.capacity_minutes - tasksDueOn(tasks, d).reduce((s, t) => s + estimate(t), 0)]));
  return pending.map((task) => {
    const need = estimate(task);
    const date = days.find((d) => free.get(d)! >= need)
      ?? days.reduce((best, d) => (free.get(d)! > free.get(best)! ? d : best), days[0]);
    free.set(date, free.get(date)! - need);
    return { task, date };
  });
}

/** Activas sin tocar en más de STALE_DAYS días que no estén ya en el bloque de atrasadas. */
export function staleTasks(tasks: Task[], today: ISODate, now: Date = new Date()): Task[] {
  const limit = now.getTime() - STALE_DAYS * 86_400_000;
  return tasks
    .filter((t) => isActive(t) && Date.parse(t.last_touched_at) < limit && !(t.due_date && t.due_date < today))
    .sort((a, b) => a.last_touched_at.localeCompare(b.last_touched_at));
}

export interface DailySummary {
  top: Task[];
  overdueCount: number;
  dueTodayCount: number;
  load: number;
  capacity: number;
  overloaded: boolean;
}

/**
 * Las 3 más importantes: primero las de hoy y atrasadas, por prioridad, vencimiento y antigüedad;
 * si no llegan a 3, se completan con las de prioridad 1-2 de los próximos días o sin fecha.
 */
export function dailySummary(tasks: Task[], today: ISODate, settings: Settings): DailySummary {
  const active = tasks.filter(isActive);
  const urgent = active.filter((t) => t.due_date && t.due_date <= today).sort(compareByUrgency);
  const backup = active
    .filter((t) => t.priority <= 2 && (!t.due_date || (t.due_date > today && diffDays(today, t.due_date) <= 7)))
    .sort(compareByUrgency);
  const dueToday = tasksDueOn(tasks, today);
  const load = dueToday.reduce((s, t) => s + (t.estimated_minutes ?? 0), 0);
  const capacity = settings.workdays.includes(weekdayOf(today)) ? settings.capacity_minutes : 0;
  return {
    top: [...urgent, ...backup].slice(0, 3),
    overdueCount: urgent.filter((t) => t.due_date! < today).length,
    dueTodayCount: dueToday.length,
    load,
    capacity,
    overloaded: load > capacity,
  };
}

/**
 * ¿Toca la revisión semanal? De viernes a lunes, si no se ha hecho desde el viernes anterior
 * (así la del viernes cuenta para el fin de semana y el lunes siguiente).
 */
export function reviewDue(lastReview: ISODate | null, today: ISODate): boolean {
  const wd = weekdayOf(today);
  if (![5, 6, 0, 1].includes(wd)) return false;
  // Viernes de referencia: el más reciente (hoy si es viernes).
  const friday = addDays(today, -((wd + 2) % 7));
  return !lastReview || lastReview < friday;
}
