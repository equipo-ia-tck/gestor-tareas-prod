import { useMemo, useSyncExternalStore } from 'react';
import { parseIcs, type CalendarEvent } from '../../domain/ics';
import { outlookToCalendar, type OutlookEvent } from '../../domain/outlookEvents';
import { nameKey } from '../../domain/text';
import type { ISODate } from '../../domain/types';
import { LOCAL_SERVER, serverCall as call } from '../../data/serverApi';
import { sync } from '../../data/sync';

export interface CalendarStatus {
  /** Enlace ICS publicado (solo disponibilidad en WPP). */
  connected: boolean;
  host: string | null;
  /** Archivo de Power Automate en OneDrive (reuniones con título). */
  file: { linked: boolean; found: boolean };
  /** Hay reuniones subidas a Supabase desde el Mac (`npm run subir`): lo que usa la app publicada. Lo pone la app. */
  cloud?: boolean;
}

/** Hay alguna fuente de reuniones: el archivo del flujo, las subidas a Supabase o el enlace ICS. */
export const hasCalendar = (s: CalendarStatus | null) => !!s && (s.connected || s.file.linked || !!s.cloud);

/** Sin servidor local (p. ej. en Vercel): ninguna fuente del servidor. */
const NO_SERVER: CalendarStatus = { connected: false, host: null, file: { linked: false, found: false } };

/** Reuniones subidas a Supabase por `scripts/subir-onedrive.ts`. */
export interface CloudCalendar {
  events: OutlookEvent[];
  fileAt: string | null;
  uploadedAt: string;
}

/** Lo subido a Supabase (null si no hay nada o falta la migración 005). Cada persona solo ve lo suyo (RLS). */
async function cloudCalendar(): Promise<CloudCalendar | null> {
  const { data, error } = await sync().supabase.from('connector_uploads')
    .select('data, file_at, uploaded_at').eq('kind', 'calendario').maybeSingle();
  if (error || !data) return null;
  const row = data as { data: OutlookEvent[]; file_at: string | null; uploaded_at: string };
  return { events: Array.isArray(row.data) ? row.data : [], fileAt: row.file_at, uploadedAt: row.uploaded_at };
}

/** Clave de subida para `npm run subir` (funciones de la migración 005). */
export const uploadTokenApi = {
  info: async () => {
    const { data, error } = await sync().supabase.rpc('upload_token_info');
    if (error) throw new Error(/upload_token_info/.test(error.message) ? 'Falta aplicar en Supabase la migración 005_calendario_subido.sql.' : error.message);
    return data as { hasToken: boolean; createdAt: string | null };
  },
  create: async () => {
    const { data, error } = await sync().supabase.rpc('create_upload_token');
    if (error) throw new Error(error.message);
    return data as string;
  },
  revoke: async () => {
    const { error } = await sync().supabase.rpc('revoke_upload_token');
    if (error) throw new Error(error.message);
  },
};


/** Calendario de Outlook del servidor (`servidor/calendar.ts`): el enlace ICS nunca llega al navegador. */
export const calendarApi = {
  status: () => call<CalendarStatus>('GET', '/api/calendar'),
  connect: (url: string) => call<CalendarStatus>('POST', '/api/calendar/connect', { url }),
  disconnect: () => call<CalendarStatus>('POST', '/api/calendar/disconnect', {}),
  ics: (fresh: boolean) => call<{ ics: string }>('GET', `/api/calendar/ics${fresh ? '?fresh=1' : ''}`).then((r) => r.ics),
  linkFile: () => call<CalendarStatus>('POST', '/api/calendar/file/link', {}),
  unlinkFile: () => call<CalendarStatus>('POST', '/api/calendar/file/unlink', {}),
  events: () => call<{ events: OutlookEvent[]; updatedAt: string }>('GET', '/api/calendar/events'),
};

/** Cada cuánto se vuelve a leer (el servidor solo relee el archivo del flujo si ha cambiado). */
const EVERY_MS = 5 * 60_000;

interface OutlookState {
  status: CalendarStatus | null;
  /** Texto del .ics (null hasta la primera descarga). */
  ics: string | null;
  /** Reuniones del archivo de Power Automate (mandan sobre el .ics) y cuándo lo escribió el flujo. */
  events: OutlookEvent[] | null;
  fileAt: string | null;
  /** Lo subido a Supabase desde el Mac (se usa si el servidor local no tiene el archivo vinculado). */
  cloud: CloudCalendar | null;
  /** Hay servidor local (npm start): sin él no se pueden vincular archivos ni el enlace ICS. */
  server: boolean;
  loading: boolean;
  error: string | null;
  /** Hora de la última descarga correcta. */
  at: number | null;
}

/** Estado compartido por todas las vistas: una sola descarga para Semana, Mes y Ajustes. */
let state: OutlookState = { status: null, ics: null, events: null, fileAt: null, cloud: null, server: false, loading: false, error: null, at: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<OutlookState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

let inflight: Promise<void> | null = null;
let stop: (() => void) | null = null;

/** Lee el estado y, si está conectado, el calendario (`fresh` salta la caché del servidor). */
export function loadOutlook(fresh = false): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    set({ loading: true });
    try {
      // El servidor local (npm start) y lo subido a Supabase, a la vez. En Vercel no hay servidor: solo cuenta lo subido.
      const [serverRes, cloudRes] = await Promise.allSettled([
        LOCAL_SERVER ? calendarApi.status() : Promise.reject(new Error('Sin servidor local.')),
        cloudCalendar(),
      ]);
      const cloud = cloudRes.status === 'fulfilled' ? cloudRes.value : null;
      const server = serverRes.status === 'fulfilled';
      const status: CalendarStatus = { ...(server ? serverRes.value : NO_SERVER), cloud: !!cloud };
      set({ status, server, cloud });
      // El archivo del flujo trae los títulos (el del servidor local, o si no, el subido); el .ics (solo
      // disponibilidad) se usa si no hay ninguno o falla.
      let file: { events: OutlookEvent[]; updatedAt: string | null } | null = null;
      let fileError: string | null = null;
      if (status.file.linked) {
        try { file = await calendarApi.events(); } catch (e) { fileError = (e as Error).message; }
      }
      if (!file && cloud) file = { events: cloud.events, updatedAt: cloud.fileAt ?? cloud.uploadedAt };
      const ics = status.connected && !file ? await calendarApi.ics(fresh) : null;
      const serverError = serverRes.status === 'rejected' && LOCAL_SERVER ? (serverRes.reason as Error).message : null;
      set({ events: file?.events ?? null, fileAt: file?.updatedAt ?? null, ics, error: file ? null : fileError ?? serverError, at: hasCalendar(status) ? Date.now() : null });
      prunePending();
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
      inflight = null;
    }
  })();
  return inflight;
}

export async function connectOutlook(url: string) {
  const status = await calendarApi.connect(url);
  set({ status });
  await loadOutlook(true);
}

export async function disconnectOutlook() {
  set({ status: await calendarApi.disconnect(), ics: null, error: null });
  await loadOutlook();
}

export async function linkOutlookFile() {
  set({ status: await calendarApi.linkFile() });
  await loadOutlook(true);
}

export async function unlinkOutlookFile() {
  set({ status: await calendarApi.unlinkFile(), events: null, fileAt: null });
  await loadOutlook();
}

/**
 * Reuniones creadas desde el gestor (se abren en Teams para enviarlas): se ven como pendientes hasta que llegan del
 * calendario real con el mismo título, día y hora, o pasan 2 horas. En localStorage, para que sobrevivan a recargar.
 */
const PENDING_KEY = 'pending-meetings';
const PENDING_MS = 2 * 60 * 60_000;
type Pending = CalendarEvent & { createdAt: number };
let pending: Pending[] = readPending();

function readPending(): Pending[] {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as Pending[];
    return Array.isArray(list) ? list.filter((p) => Date.now() - p.createdAt < PENDING_MS) : [];
  } catch {
    return [];
  }
}

function savePending(list: Pending[]) {
  pending = list;
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* solo en memoria */ }
  set({});
}

const sameMeeting = (a: CalendarEvent, b: CalendarEvent) => a.date === b.date && a.time === b.time && nameKey(a.title) === nameKey(b.title);

/** Reuniones reales de los días con pendientes (del archivo del flujo o del .ics). */
function realMeetings(from: ISODate, to: ISODate): CalendarEvent[] {
  try {
    return state.events ? outlookToCalendar(state.events, from, to) : state.ics ? parseIcs(state.ics, from, to) : [];
  } catch {
    return [];
  }
}

/**
 * Quita las pendientes que ya han llegado del calendario real (y las caducadas). Se borran para siempre: si después
 * se elimina la reunión en Teams, tiene que desaparecer, no volver a salir como pendiente.
 */
function prunePending() {
  const alive = pending.filter((p) => Date.now() - p.createdAt < PENDING_MS);
  if (!alive.length) { if (pending.length) savePending([]); return; }
  const dates = alive.map((p) => p.date).sort();
  const real = realMeetings(dates[0], dates[dates.length - 1]);
  const left = alive.filter((p) => !real.some((e) => sameMeeting(e, p)));
  if (left.length !== pending.length) savePending(left);
}

export const isPendingMeeting = (e: CalendarEvent) => e.uid.startsWith('pending:');

export function addPendingMeeting(e: Omit<CalendarEvent, 'uid'>) {
  savePending([...pending, { ...e, uid: `pending:${crypto.randomUUID()}`, createdAt: Date.now() }]);
}

export function removePendingMeeting(uid: string) {
  savePending(pending.filter((p) => p.uid !== uid));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  // Con alguien mirando: primera carga y después cada 5 minutos y al volver a la ventana.
  if (listeners.size === 1) {
    if (!state.status && !inflight) void loadOutlook();
    const timer = setInterval(() => { if (hasCalendar(state.status)) void loadOutlook(); }, EVERY_MS);
    const onFocus = () => { if (hasCalendar(state.status) && Date.now() - (state.at ?? 0) > 60_000) void loadOutlook(); };
    window.addEventListener('focus', onFocus);
    stop = () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) { stop?.(); stop = null; }
  };
};

export function useOutlook(): OutlookState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Reuniones de Outlook entre dos días (incluidos), por día. Vacío si no está conectado. */
export function useMeetings(from: ISODate, to: ISODate): Map<ISODate, CalendarEvent[]> {
  // `state` cambia también al añadir o quitar pendientes (`set({})`), así se recalcula.
  const snapshot = useOutlook();
  return useMemo(() => {
    const { ics, events } = snapshot;
    const byDay = new Map<ISODate, CalendarEvent[]>();
    let list: CalendarEvent[] = [];
    try {
      list = events ? outlookToCalendar(events, from, to) : ics ? parseIcs(ics, from, to) : [];
    } catch {
      // Un .ics raro no debe romper el calendario.
    }
    // Las pendientes, mientras no llegue la de verdad (al llegar, `prunePending` las borra).
    const waiting = pending.filter((p) => Date.now() - p.createdAt < PENDING_MS && p.date >= from && p.date <= to && !list.some((e) => sameMeeting(e, p)));
    for (const e of [...list, ...waiting]) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
    return byDay;
  }, [snapshot, from, to]);
}
