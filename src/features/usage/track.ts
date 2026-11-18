import { sync } from '../../data/sync';
import { QUALITY_MS } from '../../domain/usage';

/**
 * Analítica de uso (Más → Analítica). `UsageTracker` dice en qué pantalla se está; el resto de la app llama a `track`
 * cuando se hace algo. Nunca se manda texto escrito por la persona: `name` y `detail` son claves fijas del código.
 */
let screen = '';
let visibleSince: number | null = null; // desde cuándo está a la vista la pantalla actual
let visibleMs = 0; // tiempo a la vista ya contado de esta visita
let quality = false;
let qualityTimer: ReturnType<typeof setTimeout> | null = null;

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.,:-]+/g, '-').slice(0, 200);

function markQuality() {
  if (quality || !screen) return;
  quality = true;
  sync().logUsage('quality', screen);
}

function armQualityTimer() {
  if (qualityTimer) clearTimeout(qualityTimer);
  qualityTimer = null;
  if (quality || !screen || visibleSince === null) return;
  qualityTimer = setTimeout(markQuality, Math.max(0, QUALITY_MS - visibleMs));
}

/** Manda el tiempo a la vista que lleva acumulado la visita (al salir de la pantalla o al ocultarse la pestaña). */
function flushTime() {
  if (visibleSince !== null) { visibleMs += Date.now() - visibleSince; visibleSince = visible() ? Date.now() : null; }
  const seconds = Math.round(visibleMs / 1000);
  if (screen && seconds > 0) sync().logUsage('visit', screen, '', '', Math.min(seconds, 4 * 3600));
  visibleMs = 0;
}

/** Empieza una visita a una pantalla (cada cambio de pantalla y cada entrada nueva en la app). */
export function startVisit(next: string) {
  flushTime();
  screen = next;
  quality = false;
  visibleMs = 0;
  visibleSince = visible() ? Date.now() : null;
  sync().logUsage('screen', screen);
  armQualityTimer();
}

/** La pestaña se oculta o vuelve a verse: el tiempo oculto no cuenta. */
export function visibilityChanged() {
  if (!visible()) {
    flushTime();
    visibleSince = null;
    if (qualityTimer) clearTimeout(qualityTimer);
    qualityTimer = null;
  } else if (visibleSince === null) {
    visibleSince = Date.now();
    armQualityTimer();
  }
}

export const currentScreen = () => screen;

/** Algo que se hace en la pantalla actual: cuenta para el KPI y hace «de calidad» la visita. */
/** `value` = cuántas cosas (p. ej. tareas añadidas de golpe); por defecto, 1. */
export function track(name: string, detail = '', value = 1) {
  markQuality();
  sync().logUsage('action', screen, name, clean(detail), value);
}

/** Algo que pasa solo (p. ej. un cambio que trae Rally): cuenta, pero no hace «de calidad» la visita. */
export function trackAuto(name: string, detail = '', value = 1) {
  sync().logUsage('action', screen, name, clean(detail), value);
}

/** Una preferencia de la persona (la analítica usa la última). */
export function trackState(name: string, detail = '', value: number | null = null) {
  sync().logUsage('state', screen, name, clean(detail), value);
}
