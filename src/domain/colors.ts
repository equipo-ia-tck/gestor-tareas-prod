import { nameKey } from './text';
import type { Label } from './types';

/**
 * Paleta de Marea para proyectos, grupos, etiquetas y personas: solo colores de la marca (azul de foco, coral y coral
 * claro, verdes de éxito, azul claro, gris tinta) y dos mezclas de ellos (azul marino con azul y con coral). El orden
 * separa los parecidos (comprobado con el validador de paletas: daltonismo y visión normal entre vecinos); como siempre van
 * con su nombre al lado, no hace falta más. El azul marino puro no está: desaparecería sobre el fondo oscuro.
 */
export const BRAND_COLORS = [
  '#2E6BE6', '#D9543A', '#5CC9A0', '#7A3F42', '#8FB3FF', '#1F7A5C', '#F08A6E', '#244B98', '#A9B3C7', '#5A6478',
];

/** Paleta de antes (proyectos y grupos), para pasar sus colores a los de Marea en el mismo orden. */
export const OLD_PROJECT_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#8b5cf6', '#14b8a6', '#84cc16', '#f97316',
];
/** Paleta de antes de etiquetas y personas. */
export const OLD_LABEL_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#64748b',
];

/** Color de Marea que sustituye a uno de las paletas de antes (null si no es de ellas: se deja como está). */
export function brandColorFor(hex: string): string | null {
  const h = hex.toLowerCase();
  const i = OLD_PROJECT_COLORS.indexOf(h);
  if (i >= 0) return BRAND_COLORS[i % BRAND_COLORS.length];
  const j = OLD_LABEL_COLORS.indexOf(h);
  return j >= 0 ? BRAND_COLORS[j % BRAND_COLORS.length] : null;
}

/** Texto que se lee sobre un color (blanco sobre los oscuros, azul marino sobre los claros). */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.35 ? '#1B2B4B' : '#FFFFFF';
}

/** Etiquetas y personas usan la misma paleta de Marea. */
export const LABEL_COLORS = BRAND_COLORS;

function hash(s: string): number {
  let h = 0;
  for (const ch of nameKey(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Color estable derivado del nombre (la misma etiqueta o persona siempre tiene el mismo color). */
export const colorFor = (name: string) => LABEL_COLORS[hash(name) % LABEL_COLORS.length];

export function labelColor(name: string, labels: Label[] | Map<string, string>): string {
  const custom = labels instanceof Map ? labels.get(nameKey(name)) : labels.find((l) => nameKey(l.name) === nameKey(name))?.color;
  return custom ?? colorFor(name);
}

export const labelColorMap = (labels: Label[]) => new Map(labels.map((l) => [nameKey(l.name), l.color]));

/** "Ana María López" → "AM". */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Fondo suave a partir de un color hex (para chips y columnas). */
export const tint = (hex: string, alpha = 0.15) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
