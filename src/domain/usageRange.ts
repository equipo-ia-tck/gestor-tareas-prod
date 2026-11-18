/** Periodos de Más → Analítica: atajos, rango libre, mover adelante y atrás, periodo anterior y agrupar por día, semana o mes. */
import { addDays, addMonths, diffDays, isoWeek, mondayOf } from './dates';
import type { ISODate } from './types';

export type RangePreset = '7d' | '30d' | '90d' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | '3m' | '6m' | '12m';
/** Lo que se guarda: un atajo (se recalcula cada día) o unas fechas fijas. */
export type UsageRange = { preset: RangePreset } | { from: ISODate; to: ISODate };
export type Granularity = 'day' | 'week' | 'month';

export const PRESETS: { id: RangePreset; label: string; group: string }[] = [
  { id: '7d', label: 'Últimos 7 días', group: 'Días' },
  { id: '30d', label: 'Últimos 30 días', group: 'Días' },
  { id: '90d', label: 'Últimos 90 días', group: 'Días' },
  { id: 'this-week', label: 'Esta semana', group: 'Semanas' },
  { id: 'last-week', label: 'Semana pasada', group: 'Semanas' },
  { id: 'this-month', label: 'Este mes', group: 'Meses' },
  { id: 'last-month', label: 'Mes pasado', group: 'Meses' },
  { id: '3m', label: 'Últimos 3 meses', group: 'Meses' },
  { id: '6m', label: 'Últimos 6 meses', group: 'Meses' },
  { id: '12m', label: 'Últimos 12 meses', group: 'Meses' },
];

/** Los datos de uso se guardan 400 días: no se puede pedir antes. */
export const MAX_DAYS_BACK = 400;

const firstOfMonth = (d: ISODate): ISODate => `${d.slice(0, 7)}-01`;
const lastOfMonth = (d: ISODate): ISODate => addDays(addMonths(firstOfMonth(d), 1), -1);

/** Fechas de un periodo (las de un atajo dependen de hoy). Nunca termina después de hoy y `from <= to`. */
export function resolveRange(r: UsageRange, today: ISODate): { from: ISODate; to: ISODate } {
  if ('from' in r) {
    const to = r.to > today ? today : r.to;
    return { from: r.from > to ? to : r.from, to };
  }
  switch (r.preset) {
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case '90d': return { from: addDays(today, -89), to: today };
    case 'this-week': return { from: mondayOf(today), to: today };
    case 'last-week': { const m = addDays(mondayOf(today), -7); return { from: m, to: addDays(m, 6) }; }
    case 'this-month': return { from: firstOfMonth(today), to: today };
    case 'last-month': { const f = addMonths(firstOfMonth(today), -1); return { from: f, to: lastOfMonth(f) }; }
    case '3m': return { from: addDays(addMonths(today, -3), 1), to: today };
    case '6m': return { from: addDays(addMonths(today, -6), 1), to: today };
    case '12m': return { from: addDays(addMonths(today, -12), 1), to: today };
  }
}

export const rangeDays = (from: ISODate, to: ISODate) => diffDays(from, to) + 1;

const isWholeMonths = (from: ISODate, to: ISODate) => from === firstOfMonth(from) && to === lastOfMonth(to);
const monthsBetween = (from: ISODate, to: ISODate) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/**
 * El mismo periodo, movido hacia atrás (-1) o hacia delante (+1). Si son meses enteros se mueve por meses (así «octubre»
 * pasa a «septiembre» entero); si no, por su número de días (una semana, 7 días…).
 */
export function shiftRange(from: ISODate, to: ISODate, dir: -1 | 1): { from: ISODate; to: ISODate } {
  if (isWholeMonths(from, to)) {
    const n = monthsBetween(from, to) * dir;
    const f = addMonths(from, n);
    return { from: f, to: lastOfMonth(addMonths(f, Math.abs(n) - 1)) };
  }
  const n = rangeDays(from, to) * dir;
  return { from: addDays(from, n), to: addDays(to, n) };
}

/** El periodo anterior de la misma duración, para comparar. */
export const previousRange = (from: ISODate, to: ISODate) => shiftRange(from, to, -1);

/** Texto del periodo: «Semana 46 · 10–16 nov 2026», «octubre 2026», «1 sept – 15 nov 2026»… */
export function rangeLabel(from: ISODate, to: ISODate): string {
  const d = (iso: ISODate, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', opts);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (isWholeMonths(from, to)) {
    return monthsBetween(from, to) === 1 ? d(from, { month: 'long', year: 'numeric' })
      : `${d(from, { month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${d(to, { month: 'short', year: 'numeric' })}`;
  }
  const span = from === to ? d(from, { day: 'numeric', month: 'short', year: 'numeric' })
    : `${d(from, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${d(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return mondayOf(from) === from && addDays(from, 6) === to ? `Semana ${isoWeek(from)} · ${span}` : span;
}

/** Agrupación por defecto según la duración: días hasta un mes, semanas hasta 4 meses, meses a partir de ahí. */
export const autoGranularity = (days: number): Granularity => (days <= 31 ? 'day' : days <= 120 ? 'week' : 'month');

export interface Bucket { key: string; from: ISODate; to: ISODate; label: string; sessions: number; people: number; days: number }

/**
 * Agrupa una serie diaria por día, semana (lunes a domingo) o mes. `people` = personas distintas en el tramo, a partir de
 * `usersByDay` (las de cada día). Los tramos se recortan al periodo.
 */
export function bucketSeries(series: { day: ISODate; sessions: number }[], usersByDay: Map<ISODate, Set<string>>, g: Granularity): Bucket[] {
  const out = new Map<string, Bucket & { users: Set<string> }>();
  for (const p of series) {
    const start = g === 'day' ? p.day : g === 'week' ? mondayOf(p.day) : firstOfMonth(p.day);
    let b = out.get(start);
    if (!b) {
      const label = g === 'day' ? new Date(`${p.day}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
        : g === 'week' ? `Sem. ${isoWeek(start)}`
        : new Date(`${start}T12:00:00`).toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
      b = { key: start, from: p.day, to: p.day, label, sessions: 0, people: 0, days: 0, users: new Set() };
      out.set(start, b);
    }
    b.to = p.day;
    b.sessions += p.sessions;
    b.days += 1;
    for (const u of usersByDay.get(p.day) ?? []) b.users.add(u);
  }
  return [...out.values()].map(({ users, ...b }) => ({ ...b, people: users.size }));
}

/** Variación respecto al periodo anterior, en %, o null si antes no había nada. */
export const delta = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

/** «2026-W46» (campo de semana del navegador) → lunes de esa semana ISO. */
export function mondayOfIsoWeek(value: string): ISODate | null {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(value);
  if (!m) return null;
  const week1 = mondayOf(`${m[1]}-01-04`);
  return addDays(week1, (Number(m[2]) - 1) * 7);
}

/** Lunes → «2026-W46» (para el campo de semana). */
export function isoWeekValue(monday: ISODate): string {
  const thursday = addDays(monday, 3);
  return `${thursday.slice(0, 4)}-W${String(isoWeek(monday)).padStart(2, '0')}`;
}

/** «2026-10» (campo de mes) → el mes entero. */
export function monthRange(value: string): { from: ISODate; to: ISODate } | null {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const from = `${value}-01`;
  return { from, to: lastOfMonth(from) };
}
