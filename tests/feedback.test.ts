import { describe, expect, it } from 'vitest';
import { areaForHash, browserSummary, feedbackPriority, feedbackTaskTitle } from '../src/domain/feedback';

describe('feedback', () => {
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
