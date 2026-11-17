import { describe, expect, it } from 'vitest';
import { dailyUsage, screenOf, summarizeUsers, usedScreens, type UsageReport } from '../src/domain/usage';

const report: UsageReport = {
  users: [
    { id: 'a', name: 'Ana', login: 'ana@x.com', disabled: false },
    { id: 'b', name: 'Bea', login: 'bea@x.com', disabled: false },
    { id: 'c', name: 'Carla', login: 'carla@x.com', disabled: false },
  ],
  rows: [
    { user: 'a', day: '2026-11-16', kind: 'session', screen: '', count: 2, last: '2026-11-16T10:00:00Z' },
    { user: 'a', day: '2026-11-16', kind: 'screen', screen: 'board', count: 5, last: '2026-11-16T11:00:00Z' },
    { user: 'a', day: '2026-11-17', kind: 'session', screen: '', count: 1, last: '2026-11-17T09:00:00Z' },
    { user: 'a', day: '2026-11-17', kind: 'screen', screen: 'today', count: 1, last: '2026-11-17T09:00:00Z' },
    { user: 'b', day: '2026-11-17', kind: 'session', screen: '', count: 4, last: '2026-11-17T12:00:00Z' },
    { user: 'b', day: '2026-11-17', kind: 'screen', screen: 'rally', count: 3, last: '2026-11-17T12:30:00Z' },
  ],
};

describe('analítica de uso', () => {
  it('pantalla de una ruta, sin ids ni textos', () => {
    expect(screenOf({ view: 'project', id: 'p1' })).toBe('project');
    expect(screenOf({ view: 'search', q: 'secreto' })).toBe('search');
    expect(screenOf({ view: 'week' })).toBe('calendar');
    expect(screenOf({ view: 'all' })).toBe('board');
  });

  it('resumen por persona, incluidas las que no han entrado', () => {
    const s = summarizeUsers(report);
    expect(s.map((p) => p.user.id)).toEqual(['b', 'a', 'c']);
    expect(s[1]).toMatchObject({ sessions: 3, screens: 6, activeDays: 2, top: 'board', last: '2026-11-17T09:00:00Z' });
    expect(s[2]).toMatchObject({ sessions: 0, screens: 0, activeDays: 0, top: null, last: null });
  });

  it('por día, de una persona o del equipo, con los días sin uso a cero', () => {
    const team = dailyUsage(report, '2026-11-15', '2026-11-17', null);
    expect(team.map((d) => d.day)).toEqual(['2026-11-17', '2026-11-16', '2026-11-15']);
    expect(team[0]).toEqual({ day: '2026-11-17', sessions: 5, screens: { today: 1, rally: 3 } });
    expect(team[2]).toEqual({ day: '2026-11-15', sessions: 0, screens: {} });
    const ana = dailyUsage(report, '2026-11-15', '2026-11-17', 'a');
    expect(ana[0]).toEqual({ day: '2026-11-17', sessions: 1, screens: { today: 1 } });
    expect(usedScreens(team)).toEqual(['today', 'board', 'rally']);
  });
});
