import { useEffect, useRef } from 'react';
import type { Route } from '../../app/router';
import { sync } from '../../data/sync';
import { screenOf, SESSION_GAP_MS } from '../../domain/usage';

/** Una sola entrada por carga de la página (StrictMode monta los efectos dos veces en desarrollo). */
let opened = false;

/**
 * Apunta la analítica de uso (Más → Analítica): una entrada al abrir la app y al volver a ella tras 30 min sin mirarla,
 * y una visita cada vez que se pasa a otra pantalla (escribir en Buscar o abrir otro proyecto no cuenta otra vez).
 */
export function UsageTracker({ route }: { route: Route }) {
  const screen = screenOf(route);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const lastScreen = useRef<string | null>(null);

  useEffect(() => {
    if (!opened) { opened = true; sync().logUsage('session'); }
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt !== null && Date.now() - hiddenAt >= SESSION_GAP_MS) {
        sync().logUsage('session');
        // La pantalla en la que se vuelve cuenta como visita de la entrada nueva.
        lastScreen.current = screenRef.current;
        sync().logUsage('screen', screenRef.current);
      }
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (lastScreen.current === screen) return;
    lastScreen.current = screen;
    sync().logUsage('screen', screen);
  }, [screen]);

  return null;
}
