import { describe, expect, it } from 'vitest';
import { DEFAULT_TODAY_LAYOUT, moveTodayCard, resolveTodayLayout } from '../src/domain/todayLayout';
import { ago } from '../src/features/today/rallyRecent';

describe('Hoy: diseño de cada persona', () => {
  it('sin diseño guardado, el de serie', () => {
    expect(resolveTodayLayout(null)).toEqual(DEFAULT_TODAY_LAYOUT);
  });

  it('quita lo que ya no existe y lo repetido, ajusta el ancho y añade las tarjetas nuevas al final', () => {
    const out = resolveTodayLayout([
      { id: 'board', span: 7, hidden: false },
      { id: 'vieja', span: 1, hidden: false },
      { id: 'notes', span: 1, hidden: true },
      { id: 'board', span: 1, hidden: false },
    ]);
    expect(out.slice(0, 2)).toEqual([{ id: 'board', span: 3, hidden: false }, { id: 'notes', span: 1, hidden: true }]);
    expect(out.map((c) => c.id).sort()).toEqual(DEFAULT_TODAY_LAYOUT.map((c) => c.id).sort());
  });

  it('mueve una tarjeta antes o después de otra', () => {
    const ids = (l: { id: string }[]) => l.map((c) => c.id);
    expect(ids(moveTodayCard(DEFAULT_TODAY_LAYOUT, 'board', 'myday', false))).toEqual(['board', 'myday', 'meetings', 'topics', 'rally', 'notes']);
    expect(ids(moveTodayCard(DEFAULT_TODAY_LAYOUT, 'myday', 'topics', true))).toEqual(['meetings', 'topics', 'myday', 'rally', 'notes', 'board']);
    expect(moveTodayCard(DEFAULT_TODAY_LAYOUT, 'myday', 'myday', true)).toBe(DEFAULT_TODAY_LAYOUT);
  });

  it('«hace X» de los cambios de Rally y las notas', () => {
    const now = Date.parse('2026-11-27T12:00:00+01:00');
    expect(ago('2026-11-27T11:55:00+01:00', now)).toBe('hace 5 min');
    expect(ago('2026-11-27T09:00:00+01:00', now)).toBe('hace 3 h');
    expect(ago('2026-11-26T10:00:00+01:00', now)).toBe('ayer');
  });
});
