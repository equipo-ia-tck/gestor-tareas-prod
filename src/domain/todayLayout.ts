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
export const DEFAULT_TODAY_LAYOUT: TodayCardLayout[] = TODAY_CARDS.map((c) => ({ id: c.id, span: c.span, hidden: false }));

/** El diseño guardado, sin tarjetas que ya no existen ni repetidas, y con las nuevas al final. null = el de serie. */
export function resolveTodayLayout(saved: TodayCardLayout[] | null): TodayCardLayout[] {
  if (!saved) return DEFAULT_TODAY_LAYOUT;
  const seen = new Set<string>();
  const known = saved.filter((c) => TODAY_CARDS.some((x) => x.id === c.id) && !seen.has(c.id) && seen.add(c.id))
    .map((c) => ({ ...c, span: Math.min(3, Math.max(1, Math.round(c.span) || 1)) }));
  return [...known, ...DEFAULT_TODAY_LAYOUT.filter((c) => !seen.has(c.id))];
}

/** Mueve la tarjeta `from` antes (o después) de `to`. */
export function moveTodayCard(layout: TodayCardLayout[], from: string, to: string, after: boolean): TodayCardLayout[] {
  const card = layout.find((c) => c.id === from);
  if (!card || from === to) return layout;
  const next = layout.filter((c) => c.id !== from);
  const at = next.findIndex((c) => c.id === to);
  if (at < 0) return layout;
  next.splice(after ? at + 1 : at, 0, card);
  return next;
}
