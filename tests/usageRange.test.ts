import { describe, expect, it } from 'vitest';
import { autoGranularity, bucketSeries, delta, isoWeekValue, mondayOfIsoWeek, monthRange, previousRange, rangeDays, rangeLabel, resolveRange, shiftRange } from '../src/domain/usageRange';

const today = '2026-11-18'; // miércoles

describe('periodos de la analítica', () => {
  it('atajos', () => {
    expect(resolveRange({ preset: '7d' }, today)).toEqual({ from: '2026-11-12', to: today });
    expect(resolveRange({ preset: 'this-week' }, today)).toEqual({ from: '2026-11-16', to: today });
    expect(resolveRange({ preset: 'last-week' }, today)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(resolveRange({ preset: 'this-month' }, today)).toEqual({ from: '2026-11-01', to: today });
    expect(resolveRange({ preset: 'last-month' }, today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange({ preset: '3m' }, today)).toEqual({ from: '2026-08-19', to: today });
  });

  it('rango libre: no pasa de hoy y siempre from <= to', () => {
    expect(resolveRange({ from: '2026-11-01', to: '2026-12-31' }, today)).toEqual({ from: '2026-11-01', to: today });
    expect(resolveRange({ from: '2026-12-01', to: '2026-12-31' }, today)).toEqual({ from: today, to: today });
  });

  it('mover por semanas, por días o por meses enteros', () => {
    expect(shiftRange('2026-11-09', '2026-11-15', -1)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(shiftRange('2026-10-01', '2026-10-31', -1)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(shiftRange('2026-01-01', '2026-03-31', 1)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(shiftRange('2026-11-05', '2026-11-14', 1)).toEqual({ from: '2026-11-15', to: '2026-11-24' });
    expect(previousRange('2026-11-12', '2026-11-18')).toEqual({ from: '2026-11-05', to: '2026-11-11' });
    expect(rangeDays('2026-11-12', '2026-11-18')).toBe(7);
  });

  it('textos', () => {
    expect(rangeLabel('2026-11-09', '2026-11-15')).toBe('Semana 46 · 9 nov – 15 nov 2026');
    expect(rangeLabel('2026-10-01', '2026-10-31')).toBe('octubre de 2026');
    expect(rangeLabel('2025-12-20', '2026-01-10')).toBe('20 dic 2025 – 10 ene 2026');
  });

  it('agrupa por semana y por mes con personas distintas', () => {
    const series = ['2026-11-15', '2026-11-16', '2026-11-17'].map((day, i) => ({ day, sessions: i + 1 }));
    const users = new Map([['2026-11-15', new Set(['a'])], ['2026-11-16', new Set(['a', 'b'])], ['2026-11-17', new Set(['b'])]]);
    const weeks = bucketSeries(series, users, 'week');
    expect(weeks.map((w) => [w.key, w.sessions, w.people, w.days])).toEqual([['2026-11-09', 1, 1, 1], ['2026-11-16', 5, 2, 2]]);
    expect(bucketSeries(series, users, 'month')).toMatchObject([{ key: '2026-11-01', sessions: 6, people: 2, from: '2026-11-15', to: '2026-11-17' }]);
    expect([7, 60, 200].map(autoGranularity)).toEqual(['day', 'week', 'month']);
    expect([delta(12, 10), delta(5, 0)]).toEqual([20, null]);
  });
});

describe('campos de semana y mes', () => {
  it('convierte semana ISO y mes', () => {
    expect(mondayOfIsoWeek('2026-W46')).toBe('2026-11-09');
    expect(mondayOfIsoWeek('2027-W01')).toBe('2027-01-04');
    expect(isoWeekValue('2026-11-09')).toBe('2026-W46');
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(mondayOfIsoWeek('x')).toBeNull();
  });
});
