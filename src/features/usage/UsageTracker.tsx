import { useEffect, useRef } from 'react';
import type { Route } from '../../app/router';
import { repo } from '../../data/services';
import { sync } from '../../data/sync';
import { historyActions, screenOf, SESSION_GAP_MS } from '../../domain/usage';
import { cameFromRally } from '../rally/rallyStates';
import { startVisit, track, trackAuto, visibilityChanged } from './track';

/** Una sola entrada por carga de la página (StrictMode monta los efectos dos veces en desarrollo). */
let opened = false;

/**
 * Analítica de uso (Más → Analítica): una entrada al abrir la app y al volver tras 30 min sin mirarla, una visita por
 * pantalla (con su tiempo a la vista y si es «de calidad») y, a partir del historial de cambios, las tareas, notas y
 * proyectos que se crean y los cambios de estado (los que trae Rally, aparte).
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
      visibilityChanged();
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt !== null && Date.now() - hiddenAt >= SESSION_GAP_MS) {
        sync().logUsage('session');
        lastScreen.current = screenRef.current;
        startVisit(screenRef.current); // la pantalla en la que se vuelve es una visita de la entrada nueva
      }
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    const stopHistory = repo.onHistory(({ type, entry }) => {
      if (type !== 'push') return;
      for (const a of historyActions(entry.changes, cameFromRally(entry))) (a.auto ? trackAuto : track)(a.name, a.detail, a.count);
    });
    return () => { document.removeEventListener('visibilitychange', onVisibility); stopHistory(); };
  }, []);

  useEffect(() => {
    if (lastScreen.current === screen) return;
    lastScreen.current = screen;
    startVisit(screen);
  }, [screen]);

  return null;
}
