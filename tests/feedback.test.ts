import { describe, expect, it } from 'vitest';
import { browserSummary, feedbackTaskTitle } from '../src/domain/feedback';

describe('feedback', () => {
  it('navegador en pocas palabras', () => {
    expect(browserSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Chrome 142 · macOS');
    expect(browserSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe('Edge 142 · Windows');
    expect(browserSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15')).toBe('Safari 19 · macOS');
  });

  it('título de la tarea: tipo y primera línea recortada', () => {
    expect(feedbackTaskTitle({ kind: 'bug', body: 'El tablero no carga\nDetalles…' })).toBe('Algo roto: El tablero no carga');
    const long = feedbackTaskTitle({ kind: 'improvement', body: 'x'.repeat(200) });
    expect(long.startsWith('Mejora: ')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(8 + 90);
  });
});
