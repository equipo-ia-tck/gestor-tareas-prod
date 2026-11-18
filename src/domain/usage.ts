/** Analítica de uso (tabla `usage_events` de Supabase, migraciones 009 y 010). Funciones puras para Más → Analítica. */
import type { Route } from '../app/router';
import type { Change } from '../data/repository';
import { addDays } from './dates';
import type { ISODate, Note, Project, Task } from './types';

export type UsageKind = 'session' | 'screen' | 'visit' | 'quality' | 'action' | 'state';

/** Foto de los datos de una persona (recuentos calculados en Supabase, migración 010). */
export interface UsageSnapshot {
  tasksCreated: number; createdWithDate: number; createdWithProject: number;
  tasksActive: number; activeWithDate: number; activeWithProject: number; rallyActive: number;
  notesCreated: number; notesTotal: number; notesInSection: number; sections: number; projectsCreated: number;
  tasksFromNotes: number; tasksFromNotesDone: number;
  groups: number; peopleCards: number; peopleInGroup: number; peopleWithEmail: number; peopleWithRole: number;
  rallyConnected: boolean; lastReviewOn: string | null;
}
/** `snapshot` falta si solo está aplicada la migración 009. */
export interface UsageUser { id: string; name: string; login: string; disabled: boolean; snapshot?: UsageSnapshot }
/** Recuento de una persona en un día para un tipo de evento, pantalla, acción y detalle. `value` = suma de los valores. */
export interface UsageRow {
  user: string; day: ISODate; kind: UsageKind; screen: string; count: number; last: string;
  name?: string; detail?: string; value?: number | null;
}
/** Última preferencia de cada persona (`calendar-tasks`, `rally-columns`…). */
export interface UsageState { user: string; name: string; detail: string; value: number | null; at: string }
export interface UsageReport { users: UsageUser[]; rows: UsageRow[]; states?: UsageState[] }

/** Una visita es «de calidad» si la pantalla está a la vista este tiempo o si se hace algo en ella. */
export const QUALITY_MS = 15 * 1000;

/** Pantallas, en el orden de la barra lateral. La clave es lo que se guarda en Supabase. */
export const SCREENS: { id: string; label: string }[] = [
  { id: 'today', label: 'Hoy' },
  { id: 'inbox', label: 'Bandeja' },
  { id: 'board', label: 'Tablero' },
  { id: 'calendar', label: 'Calendario' },
  { id: 'notes', label: 'Notas' },
  { id: 'rally', label: 'Rally' },
  { id: 'project', label: 'Proyecto' },
  { id: 'people', label: 'Grupos' },
  { id: 'person', label: 'Persona' },
  { id: 'search', label: 'Buscar' },
  { id: 'review', label: 'Revisión semanal' },
  { id: 'log', label: 'Registro' },
  { id: 'settings', label: 'Ajustes' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'analytics', label: 'Analítica' },
];

export const screenLabel = (id: string) => SCREENS.find((s) => s.id === id)?.label ?? id;

/** Pantalla de una ruta, sin ids ni textos (nunca se guarda qué proyecto, persona o búsqueda). */
export function screenOf(route: Route): string {
  switch (route.view) {
    case 'week': return 'calendar';
    case 'all': return 'board';
    case 'projects': return 'today';
    default: return route.view;
  }
}

/** Una entrada nueva si se vuelve a la app tras este rato sin mirarla. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface UserSummary {
  user: UsageUser;
  sessions: number;
  screens: number;
  activeDays: number;
  last: string | null;
  /** Pantalla más abierta (null si no ha abierto ninguna). */
  top: string | null;
}

/** Una fila por cuenta (también las que no han entrado), las más activas primero. */
export function summarizeUsers(report: UsageReport): UserSummary[] {
  return report.users.map((user) => {
    const rows = report.rows.filter((r) => r.user === user.id);
    const sum = (k: UsageKind) => rows.filter((r) => r.kind === k).reduce((n, r) => n + r.count, 0);
    const perScreen = new Map<string, number>();
    for (const r of rows) if (r.kind === 'screen') perScreen.set(r.screen, (perScreen.get(r.screen) ?? 0) + r.count);
    const top = [...perScreen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const last = rows.reduce<string | null>((m, r) => (!m || r.last > m ? r.last : m), null);
    return { user, sessions: sum('session'), screens: sum('screen'), activeDays: new Set(rows.map((r) => r.day)).size, last, top };
  }).sort((a, b) => b.sessions - a.sessions || b.screens - a.screens || a.user.name.localeCompare(b.user.name, 'es'));
}

export interface DayRow { day: ISODate; sessions: number; screens: Record<string, number> }

/** Días entre dos fechas (incluidas), del más reciente al más antiguo, con las entradas y las visitas a cada pantalla.
 *  `userId` null = todo el equipo. Los días sin uso salen con ceros. */
export function dailyUsage(report: UsageReport, from: ISODate, to: ISODate, userId: string | null): DayRow[] {
  const byDay = new Map<string, DayRow>();
  for (let d = to; d >= from; d = addDays(d, -1)) byDay.set(d, { day: d, sessions: 0, screens: {} });
  for (const r of report.rows) {
    if (userId && r.user !== userId) continue;
    const row = byDay.get(r.day);
    if (!row) continue;
    if (r.kind === 'session') row.sessions += r.count;
    else if (r.kind === 'screen') row.screens[r.screen] = (row.screens[r.screen] ?? 0) + r.count;
  }
  return [...byDay.values()];
}

/** Pantallas con alguna visita, en el orden de `SCREENS` (las desconocidas, al final). */
export function usedScreens(rows: DayRow[]): string[] {
  const used = new Set(rows.flatMap((r) => Object.keys(r.screens)));
  const known = SCREENS.map((s) => s.id).filter((id) => used.has(id));
  return [...known, ...[...used].filter((id) => !known.includes(id)).sort()];
}

/** Personas distintas que han usado la app en el periodo del informe. */
export const activeUsers = (report: UsageReport) => new Set(report.rows.map((r) => r.user)).size;


export interface TrackedAction { name: string; detail: string; count: number; auto?: boolean }

/**
 * Lo que la analítica saca de una entrada del historial: tareas, notas y proyectos creados y cambios de estado. Si el
 * cambio lo ha traído Rally (`fromRally`), los cambios de estado cuentan como `rally-in` y no como algo hecho por la persona.
 */
export function historyActions(changes: Change[], fromRally: boolean): TrackedAction[] {
  const counts = new Map<string, TrackedAction>();
  const add = (name: string, detail = '', auto = false) => {
    const k = `${name}|${detail}`;
    const a = counts.get(k) ?? { name, detail, count: 0, auto };
    a.count += 1;
    counts.set(k, a);
  };
  for (const c of changes) {
    if (c.table === 'tasks') {
      const before = c.before as Task | undefined;
      const after = c.after as Task | undefined;
      if (!before && after) { if (!fromRally) add('task-create'); }
      else if (before && after && before.state_id !== after.state_id) {
        if (fromRally) add('rally-in', '', true);
        else add('state-change');
      }
    } else if (c.table === 'notes' && !c.before && c.after && !(c.after as Note).deleted_at) add('note-create');
    else if (c.table === 'projects' && !c.before && c.after && !(c.after as Project).archived) add('project-create');
  }
  return [...counts.values()];
}
