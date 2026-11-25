import { describe, expect, it } from 'vitest';
import { areaForHash, browserSummary, feedbackPriority, feedbackTaskTitle, moveFeedback, sortFeedback } from '../src/domain/feedback';

describe('feedback', () => {
  it('orden de prioridad: lo sin ordenar arriba (el más nuevo primero) y después por posición', () => {
    const f = (id: string, rank: number | null, createdAt: string) => ({ id, rank, createdAt });
    const items = [f('a', 2, '2026-11-01'), f('b', null, '2026-11-02'), f('c', 1, '2026-11-03'), f('d', null, '2026-11-05')];
    expect(sortFeedback(items).map((x) => x.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('mover uno antes o después de otro, sin perder ninguno', () => {
    const o = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(moveFeedback(o, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveFeedback(o, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveFeedback(o, 'a', 'a', 'after')).toEqual(['a', 'b', 'c', 'd']);
    expect(moveFeedback(o, 'x', 'a', 'before')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('navegador en pocas palabras', () => {
    expect(browserSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Chrome 142 · macOS');
    expect(browserSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe('Edge 142 · Windows');
    expect(browserSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15')).toBe('Safari 19 · macOS');
  });

  it('título de la tarea: tipo y primera línea recortada', () => {
    expect(feedbackTaskTitle({ kind: 'bug', title: 'El tablero no carga', body: 'Detalles…' })).toBe('Algo no funciona: El tablero no carga');
    expect(feedbackTaskTitle({ kind: 'other', title: '', body: 'Antiguo\nmás' })).toBe('Otro: Antiguo');
    const long = feedbackTaskTitle({ kind: 'improvement', title: 'x'.repeat(200), body: '' });
    expect(long.startsWith('Mejora: ')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(8 + 90);
  });

  it('parte de la web según la pantalla, y prioridad según el impacto', () => {
    expect(areaForHash('#/board')).toBe('board');
    expect(areaForHash('#/project/abc')).toBe('projects');
    expect(areaForHash('#/person/Diana')).toBe('people');
    expect(areaForHash('')).toBe('today');
    expect(areaForHash('#/raro')).toBe('other');
    expect(areaForHash('#/board', true)).toBe('task');
    expect([feedbackPriority({ impact: 'blocking' }), feedbackPriority({ impact: 'minor' }), feedbackPriority({ impact: null })]).toEqual([1, 3, 4]);
  });
});

describe('panel del feedback', () => {
  it('cuenta por estado, tipo, parte de la web, impacto y semana', async () => {
    const { feedbackStats } = await import('../src/domain/feedback');
    const base = { authorName: 'Ana', authorLogin: 'ana', title: 't', body: '', page: '', screen: '', userAgent: '', taskId: null };
    const items = [
      { ...base, id: '1', kind: 'bug', area: 'board', impact: 'blocking', status: 'new', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z' },
      { ...base, id: '2', kind: 'bug', area: 'board', impact: 'minor', status: 'done', createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-12T10:00:00Z' },
      { ...base, id: '3', kind: 'improvement', area: 'rally', impact: null, status: 'doing', createdAt: '2026-11-17T09:00:00Z', updatedAt: '2026-11-17T09:00:00Z', authorName: 'Luis' },
    ] as Parameters<typeof feedbackStats>[0];
    const s = feedbackStats(items, new Date('2026-11-17T12:00:00Z'), 2);
    expect(s).toMatchObject({ total: 3, open: 2, avgDaysToDone: 2, byStatus: { new: 1, doing: 1, blocked: 0, done: 1, dismissed: 0 } });
    expect(s.byArea.map((a) => [a.id, a.total, a.open])).toEqual([['board', 2, 1], ['rally', 1, 1]]);
    expect(s.byKind.map((k) => [k.id, k.total])).toEqual([['bug', 2], ['improvement', 1]]);
    expect(s.openBugs.find((b) => b.id === 'blocking')?.count).toBe(1);
    expect(s.weeks).toEqual([{ start: '2026-11-09', received: 1, closed: 1 }, { start: '2026-11-16', received: 2, closed: 0 }]);
    expect(s.authors[0]).toEqual({ name: 'Ana', total: 2 });
  });
});
