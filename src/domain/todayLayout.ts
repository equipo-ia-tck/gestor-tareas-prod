import type { Route } from '../app/router';
import type { TodayCardLayout } from './types';

/** Tarjetas de Hoy, en el orden de serie. `span`: columnas que ocupan (de 3). `screen`: sin esa pantalla, no sale. */
export type TodayCardId = 'myday' | 'meetings' | 'topics' | 'rally' | 'notes' | 'board';
export const TODAY_CARDS: { id: TodayCardId; label: string; span: number; screen?: Route['view'] }[] = [
  { id: 'myday', label: 'Mi día', span: 1 },
  { id: 'meetings', label: 'Reuniones', span: 1, screen: 'calendar' },
  { id: 'topics', label: 'Para hablar', span: 1, screen: 'people' },
  { id: 'rally', label: 'Rally', span: 2, screen: 'rally' },
  { id: 'notes', label: 'Últimas notas', span: 1, screen: 'notes' },
  { id: 'board', label: 'Tu tablero', span: 3, screen: 'board' },
];
/** Columnas de Hoy en pantalla ancha: las posiciones guardadas son para ellas. */
export const TODAY_COLS = 3;
export const DEFAULT_TODAY_LAYOUT: TodayCardLayout[] = TODAY_CARDS.map((c) => ({ id: c.id, span: c.span, hidden: false, x: null, y: null }));

/** El diseño guardado, sin tarjetas que ya no existen ni repetidas, y con las nuevas al final. null = el de serie. */
export function resolveTodayLayout(saved: TodayCardLayout[] | null): TodayCardLayout[] {
  if (!saved) return DEFAULT_TODAY_LAYOUT;
  const seen = new Set<string>();
  const known = saved.filter((c) => TODAY_CARDS.some((x) => x.id === c.id) && !seen.has(c.id) && seen.add(c.id))
    .map((c) => {
      const span = Math.min(TODAY_COLS, Math.max(1, Math.round(c.span) || 1));
      const x = c.x == null ? null : Math.min(TODAY_COLS - span, Math.max(0, Math.round(c.x)));
      const y = c.y == null || x == null ? null : Math.max(0, Math.round(c.y));
      return { id: c.id, span, hidden: !!c.hidden, x, y: x == null ? null : y };
    });
  return [...known, ...DEFAULT_TODAY_LAYOUT.filter((c) => !seen.has(c.id))];
}

export interface Placed { x: number; y: number; w: number; h: number }

/**
 * Dónde va cada tarjeta en pantalla ancha (columnas y filas de 4 px). Las que tienen sitio guardado van a él; si se montan
 * con otra (porque ha crecido), bajan hasta el primer hueco libre en sus columnas, sin mover a las demás. `first`: la que se
 * está arrastrando, que se coloca antes que nadie. Las que no tienen sitio guardado ocupan, por orden, el hueco más alto
 * (y a la izquierda) donde caben, así no queda espacio en blanco entre tarjetas.
 */
export function placeTodayCards(cards: TodayCardLayout[], heights: Record<string, number>, first?: string | null, cols = TODAY_COLS): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const placed: Placed[] = [];
  const hit = (a: Placed, b: Placed) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  /** El y más alto, desde `minY`, en el que cabe en esas columnas. */
  const fit = (x: number, w: number, h: number, minY: number) => {
    const tries = [minY, ...placed.map((p) => p.y + p.h).filter((y) => y > minY)].sort((a, b) => a - b);
    for (const y of tries) if (!placed.some((p) => hit(p, { x, y, w, h }))) return y;
    return Math.max(minY, ...placed.map((p) => p.y + p.h));
  };
  const put = (id: string, p: Placed) => { out.set(id, p); placed.push(p); };
  const fixed = cards.filter((c) => c.x != null && c.y != null)
    .sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.y! - b.y! || a.x! - b.x!));
  for (const c of fixed) {
    const w = Math.min(cols, c.span);
    const x = Math.min(cols - w, c.x!);
    const h = heights[c.id] ?? 40;
    put(c.id, { x, y: fit(x, w, h, c.y!), w, h });
  }
  for (const c of cards) {
    if (out.has(c.id)) continue;
    const w = Math.min(cols, c.span);
    const h = heights[c.id] ?? 40;
    let best: Placed | null = null;
    for (let x = 0; x + w <= cols; x++) {
      const y = fit(x, w, h, 0);
      if (!best || y < best.y) best = { x, y, w, h };
    }
    put(c.id, best!);
  }
  return out;
}

/** El diseño con todas las tarjetas visibles en el sitio donde se ven ahora (al soltar una, todo queda fijo). */
export function pinTodayLayout(layout: TodayCardLayout[], placed: Map<string, Placed>): TodayCardLayout[] {
  return layout.map((c) => {
    const p = placed.get(c.id);
    return p ? { ...c, x: p.x, y: p.y } : c;
  });
}
