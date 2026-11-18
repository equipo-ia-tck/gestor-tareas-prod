import { describe, expect, it } from 'vitest';
import { summarizeUsers, type UsageReport } from '../src/domain/usage';
import { activitySeries, adoption, heatLevel, percentOf, screenRanking } from '../src/domain/usageDashboard';

const row = (user: string, day: string, kind: string, screen: string, count = 1, value: number | null = null) =>
  ({ user, day, kind, screen, count, last: `${day}T10:00:00Z`, name: '', detail: '', value }) as UsageReport['rows'][number];

const report: UsageReport = {
  users: [
    { id: 'a', name: 'Ana', login: 'a', disabled: false },
    { id: 'b', name: 'Bea', login: 'b', disabled: false },
    { id: 'c', name: 'Carla', login: 'c', disabled: false },
    { id: 'd', name: 'Dani', login: 'd', disabled: true },
  ],
  rows: [
    row('a', '2026-11-16', 'session', '', 2), row('a', '2026-11-16', 'screen', 'board', 4), row('a', '2026-11-16', 'quality', 'board', 3),
    row('a', '2026-11-16', 'visit', 'board', 4, 400),
    row('b', '2026-11-17', 'session', '', 1), row('b', '2026-11-17', 'screen', 'board', 1), row('b', '2026-11-17', 'screen', 'rally', 6),
    row('a', '2026-11-17', 'screen', 'today', 1),
  ],
};

describe('panel de analítica', () => {
  it('ordena las pantallas por visitas, con calidad, personas y tiempo medio', () => {
    expect(screenRanking(report, null)).toEqual([
      { screen: 'rally', visits: 6, quality: 0, people: 1, avgSeconds: null },
      { screen: 'board', visits: 5, quality: 3, people: 2, avgSeconds: 80 },
      { screen: 'today', visits: 1, quality: 0, people: 1, avgSeconds: null },
    ]);
    expect(screenRanking(report, 'a').map((s) => s.screen)).toEqual(['board', 'today']);
  });

  it('serie diaria con entradas y personas distintas', () => {
    expect(activitySeries(report, '2026-11-15', '2026-11-17', null)).toEqual([
      { day: '2026-11-15', sessions: 0, people: 0 },
      { day: '2026-11-16', sessions: 2, people: 1 },
      { day: '2026-11-17', sessions: 1, people: 2 },
    ]);
  });

  it('adopción: activas, sin uso y desactivadas', () => {
    const a = adoption(summarizeUsers(report));
    expect(a).toMatchObject({ total: 4, active: 2, disabled: 1 });
    expect(a.idle.map((p) => p.user.id)).toEqual(['c']);
  });

  it('porcentajes y niveles del mapa de calor', () => {
    expect(percentOf('40 %')).toBe(40);
    expect(percentOf('—')).toBeNull();
    expect(percentOf('3 de 5')).toBeNull();
    expect([0, 1, 5, 10].map((v) => heatLevel(v, 10))).toEqual([0, 1, 2, 4]);
  });
});
