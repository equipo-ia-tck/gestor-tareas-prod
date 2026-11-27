import { describe, expect, it } from 'vitest';
import { DEFAULT_TODAY_LAYOUT, pinTodayLayout, placeTodayCards, resolveTodayLayout } from '../src/domain/todayLayout';
import { ago } from '../src/features/today/rallyRecent';

describe('Hoy: diseño de cada persona', () => {
  it('sin diseño guardado, el de serie', () => {
    expect(resolveTodayLayout(null)).toEqual(DEFAULT_TODAY_LAYOUT);
  });

  it('quita lo que ya no existe y lo repetido, ajusta ancho y sitio, y añade las tarjetas nuevas al final', () => {
    const out = resolveTodayLayout([
      { id: 'board', span: 7, hidden: false, x: 2, y: 10 },
      { id: 'vieja', span: 1, hidden: false, x: null, y: null },
      { id: 'notes', span: 1, hidden: true, x: 5, y: -3 },
      { id: 'board', span: 1, hidden: false, x: null, y: null },
    ]);
    expect(out.slice(0, 2)).toEqual([{ id: 'board', span: 3, hidden: false, x: 0, y: 10 }, { id: 'notes', span: 1, hidden: true, x: 2, y: 0 }]);
    expect(out.map((c) => c.id).sort()).toEqual(DEFAULT_TODAY_LAYOUT.map((c) => c.id).sort());
  });

  const card = (id: string, span: number, x: number | null = null, y: number | null = null) => ({ id, span, hidden: false, x, y });

  it('sin sitio guardado, cada tarjeta va al hueco más alto donde cabe (las pequeñas rellenan al lado de las grandes)', () => {
    const p = placeTodayCards([card('a', 1), card('b', 1), card('c', 1), card('d', 2), card('e', 1)], { a: 100, b: 30, c: 30, d: 20, e: 20 });
    expect(p.get('a')).toMatchObject({ x: 0, y: 0 });
    expect(p.get('b')).toMatchObject({ x: 1, y: 0 });
    expect(p.get('c')).toMatchObject({ x: 2, y: 0 });
    expect(p.get('d')).toMatchObject({ x: 1, y: 30 });
    expect(p.get('e')).toMatchObject({ x: 1, y: 50 });
  });

  it('con sitio guardado se queda ahí aunque deje un hueco, y solo baja si se monta con otra', () => {
    const p = placeTodayCards([card('a', 1, 0, 0), card('b', 1, 2, 80), card('c', 1, 0, 10)], { a: 40, b: 20, c: 20 });
    expect(p.get('b')).toMatchObject({ x: 2, y: 80 });
    expect(p.get('c')).toMatchObject({ x: 0, y: 40 });
  });

  it('la que se arrastra se coloca primero: las que estorban bajan y las demás no se mueven', () => {
    const cards = [card('a', 1, 0, 0), card('b', 1, 1, 0), card('c', 2, 1, 0)];
    const p = placeTodayCards(cards, { a: 30, b: 30, c: 20 }, 'c');
    expect(p.get('c')).toMatchObject({ x: 1, y: 0 });
    expect(p.get('b')).toMatchObject({ x: 1, y: 20 });
    expect(p.get('a')).toMatchObject({ x: 0, y: 0 });
    const pinned = pinTodayLayout(cards, p);
    expect(pinned.find((c) => c.id === 'b')).toMatchObject({ x: 1, y: 20 });
  });

  it('«hace X» de los cambios de Rally y las notas', () => {
    const now = Date.parse('2026-11-27T12:00:00+01:00');
    expect(ago('2026-11-27T11:55:00+01:00', now)).toBe('hace 5 min');
    expect(ago('2026-11-27T09:00:00+01:00', now)).toBe('hace 3 h');
    expect(ago('2026-11-26T10:00:00+01:00', now)).toBe('ayer');
  });
});
