import { useSyncExternalStore } from 'react';
import { useApp } from '../../app/AppContext';
import { NewMeeting, nextSlot } from '../calendar/NewMeeting';

/** Reunión que se propone después de un comentario en Rally (la entrega de la guía, al pasar a Completed). */
export interface MeetingRequest {
  title: string;
  /** Personas mencionadas en el comentario (PO y analista), con su email de Rally si lo tiene. */
  invite: { name: string; email: string | null }[];
}

let queue: MeetingRequest[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const current = () => queue[0] ?? null;

export function askMeeting(r: MeetingRequest) {
  queue = [...queue, r];
  emit();
}

/**
 * Ventana «Reunión nueva» (la del Calendario) con las personas mencionadas ya como asistentes; se pueden quitar y
 * añadir más. Hoy a la próxima media hora. Si se mueven varias, se abren de una en una.
 */
export function MeetingPrompt() {
  const request = useSyncExternalStore(subscribe, current);
  const { today } = useApp();
  if (!request) return null;
  const close = () => { queue = queue.slice(1); emit(); };
  // `key`: cada petición empieza con su propio formulario.
  return <NewMeeting key={`${request.title}-${queue.length}`} date={today} time={nextSlot()} title={request.title}
    invite={request.invite} onClose={close} />;
}
