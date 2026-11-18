/** Cálculos para el diseño en panel de Más → Analítica (gráficos y resúmenes). Funciones puras sobre `admin_usage`. */
import { addDays } from './dates';
import type { ISODate } from './types';
import type { UsageReport, UserSummary } from './usage';

export interface ScreenRank { screen: string; visits: number; quality: number; people: number; avgSeconds: number | null }

/** Pantallas con visitas en el periodo, de más a menos visitadas. `userId` null = todo el equipo. */
export function screenRanking(report: UsageReport, userId: string | null): ScreenRank[] {
  const m = new Map<string, { visits: number; quality: number; seconds: number; people: Set<string> }>();
  for (const r of report.rows) {
    if (userId && r.user !== userId) continue;
    if (r.kind !== 'screen' && r.kind !== 'quality' && r.kind !== 'visit') continue;
    const e = m.get(r.screen) ?? { visits: 0, quality: 0, seconds: 0, people: new Set<string>() };
    if (r.kind === 'screen') { e.visits += r.count; e.people.add(r.user); }
    else if (r.kind === 'quality') e.quality += r.count;
    else e.seconds += r.value ?? 0;
    m.set(r.screen, e);
  }
  return [...m].filter(([, e]) => e.visits > 0)
    .map(([screen, e]) => ({ screen, visits: e.visits, quality: Math.min(e.quality, e.visits), people: e.people.size,
      avgSeconds: e.seconds ? Math.round(e.seconds / e.visits) : null }))
    .sort((a, b) => b.visits - a.visits || a.screen.localeCompare(b.screen));
}

export interface DayPoint { day: ISODate; sessions: number; people: number }

/** Un punto por día (del más antiguo al más reciente): entradas y personas distintas que usan la app ese día. */
export function activitySeries(report: UsageReport, from: ISODate, to: ISODate, userId: string | null): DayPoint[] {
  const days: DayPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, sessions: 0, people: 0 });
  const idx = new Map(days.map((d, i) => [d.day, i]));
  const people = new Map<string, Set<string>>();
  for (const r of report.rows) {
    if (userId && r.user !== userId) continue;
    const i = idx.get(r.day);
    if (i === undefined) continue;
    if (r.kind === 'session') days[i].sessions += r.count;
    const s = people.get(r.day) ?? new Set<string>();
    s.add(r.user);
    people.set(r.day, s);
  }
  for (const d of days) d.people = people.get(d.day)?.size ?? 0;
  return days;
}

export interface Adoption { total: number; active: number; idle: UserSummary[]; disabled: number }

/** Cuentas que han usado la app en el periodo, las que no (activas) y las desactivadas. */
export function adoption(people: UserSummary[]): Adoption {
  const used = (p: UserSummary) => p.sessions > 0 || p.screens > 0;
  return {
    total: people.length,
    active: people.filter(used).length,
    idle: people.filter((p) => !used(p) && !p.user.disabled),
    disabled: people.filter((p) => !used(p) && p.user.disabled).length,
  };
}

/** «40 %» → 40; cualquier otra cosa → null (para dibujar la barra de un KPI en porcentaje). */
export function percentOf(value: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?) ?%$/.exec(value.trim());
  return m ? Math.min(100, Math.max(0, Number(m[1].replace(',', '.')))) : null;
}

/** Nivel de 0 a 4 de un valor respecto al máximo (para el mapa de calor): 0 = nada. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

/** Personas distintas que usan la app cada día (para agrupar por semana o mes sin contar dos veces a nadie). */
export function usersByDay(report: UsageReport, userId: string | null): Map<ISODate, Set<string>> {
  const m = new Map<ISODate, Set<string>>();
  for (const r of report.rows) {
    if (userId && r.user !== userId) continue;
    const s = m.get(r.day) ?? new Set<string>();
    s.add(r.user);
    m.set(r.day, s);
  }
  return m;
}
