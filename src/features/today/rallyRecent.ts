import { useEffect, useState } from 'react';
import { isRallyId } from '../../domain/rally';
import type { RecentEvent } from '../../domain/rallyActivity';
import type { Task } from '../../domain/types';
import { rallyApi } from '../rally/rallyApi';

/**
 * Hoy → «Rally · últimos cambios en lo tuyo». Se pide al abrir Hoy y cada 5 minutos, con los IDs de las tareas enlazadas.
 * Se guarda en memoria entre visitas a Hoy (no se pide otra vez si hace menos de 2 minutos).
 */
const EVERY_MS = 5 * 60_000;
let last: { at: number; key: string; events: RecentEvent[] } | null = null;

export type RecentState = { status: 'loading' | 'ok' | 'off' | 'error'; events: RecentEvent[]; error?: string };

export function useRallyRecent(tasks: Task[], enabled: boolean): RecentState {
  const ids = [...new Set(tasks.filter((t) => !t.deleted_at && t.status !== 'archived' && isRallyId(t.external_id)).map((t) => t.external_id!.replace(/-/g, '').toUpperCase()))].sort();
  const key = ids.join(',');
  const [state, setState] = useState<RecentState>(() => (last ? { status: 'ok', events: last.events } : { status: 'loading', events: [] }));

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async (force: boolean) => {
      if (!force && last && last.key === key && Date.now() - last.at < 2 * 60_000) { setState({ status: 'ok', events: last.events }); return; }
      try {
        const events = await rallyApi.recent(key ? key.split(',') : [], 3);
        last = { at: Date.now(), key, events };
        if (alive) setState({ status: 'ok', events });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Sin Rally conectado, la tarjeta invita a conectarlo.
        if (alive) setState({ status: /conecta|connect|clave/i.test(message) ? 'off' : 'error', events: last?.events ?? [], error: message });
      }
    };
    void load(false);
    const timer = setInterval(() => void load(true), EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [key, enabled]);

  return state;
}

/** «hace 5 min», «hace 3 h», «ayer», «el lunes». */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  const d = new Date(t);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `hace ${h} h`;
  if (d.toDateString() === yesterday.toDateString()) return 'ayer';
  return d.toLocaleDateString('es-ES', { weekday: 'long' });
}
