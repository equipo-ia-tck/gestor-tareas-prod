import { addDays, isWorkday } from './dates';
import { TOPIC_TYPE_ID, type ISODate, type Settings, type Task } from './types';

export const isActive = (t: Task) => t.status === 'todo' && !t.deleted_at;

/** La bandeja no es un estado: es lo activo sin fecha ni proyecto (los temas de conversación viven en su persona). */
export const isInbox = (t: Task) => isActive(t) && !t.project_id && !t.due_date && t.type_id !== TOPIC_TYPE_ID;

export const isOverdue = (t: Task, today: ISODate) =>
  isActive(t) && t.due_date !== null && t.due_date < today;

/** Prioridad (1 primero), luego orden manual, fecha y antigüedad. */
export function compareTasks(a: Task, b: Task): number {
  return (
    a.priority - b.priority ||
    a.sort_order - b.sort_order ||
    (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
    a.created_at.localeCompare(b.created_at)
  );
}

export const sortTasks = (tasks: Task[]) => [...tasks].sort(compareTasks);

export const tasksDueOn = (tasks: Task[], day: ISODate) =>
  sortTasks(tasks.filter((t) => isActive(t) && t.due_date === day));

export const overdueTasks = (tasks: Task[], today: ISODate) =>
  sortTasks(tasks.filter((t) => isOverdue(t, today)));

export const inboxTasks = (tasks: Task[]) => sortTasks(tasks.filter(isInbox));

export const completedOn = (tasks: Task[], day: ISODate) =>
  tasks.filter((t) => t.status === 'done' && !t.deleted_at && t.completed_at?.startsWith(day));

/** Minutos estimados de un conjunto de tareas (las que no tienen estimación cuentan 0). */
export const totalMinutes = (tasks: Task[]) =>
  tasks.reduce((sum, t) => sum + (t.estimated_minutes ?? 0), 0);

export interface DayPlan {
  date: ISODate;
  tasks: Task[];
  load: number;
  /** 0 en días no laborables. */
  capacity: number;
}

export function weekPlan(tasks: Task[], today: ISODate, settings: Settings, days = 7): DayPlan[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i);
    const dayTasks = tasksDueOn(tasks, date);
    return {
      date,
      tasks: dayTasks,
      load: totalMinutes(dayTasks),
      capacity: isWorkday(date, settings.workdays) ? settings.capacity_minutes : 0,
    };
  });
}

/** Personas mencionadas en tareas activas, con su número de tareas, ordenadas por uso. */
export function peopleIndex(tasks: Task[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (!isActive(t)) continue;
    for (const p of t.people) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

export const samePerson = (a: string, b: string) =>
  a.localeCompare(b, 'es', { sensitivity: 'base' }) === 0;

/** Todas las personas usadas alguna vez (también en tareas completadas), para autocompletar. */
export function knownPeople(tasks: Task[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tasks) for (const p of t.people) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * En "Mi día": pendiente y añadida hoy (cada día empieza vacío). Los temas «Para hablar» pendientes están siempre, sin
 * añadirlos, hasta que se marcan como hablados (petición de la usuaria, nov 2026).
 */
export const inMyDay = (t: Task, today: ISODate) => isActive(t) && (t.my_day === today || t.type_id === TOPIC_TYPE_ID);

export const myDayTasks = (tasks: Task[], today: ISODate) => sortTasks(tasks.filter((t) => inMyDay(t, today)));
