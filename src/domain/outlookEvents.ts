import type { CalendarEvent } from './ics';
import type { ISODate } from './types';

/**
 * Reuniones de Outlook exportadas por un flujo de Power Automate ("Obtener vista de calendario de eventos (V3)",
 * guardado como JSON en OneDrive). El servidor las recorta con `trimOutlookEvents` (sin el cuerpo HTML) y la app las
 * pasa a `CalendarEvent` en su zona horaria con `outlookToCalendar`, igual que las del .ics.
 */
export interface OutlookEvent {
  uid: string;
  title: string;
  /** Instantes ISO con zona (UTC si Outlook no la indica). */
  start: string;
  end: string | null;
  allDay: boolean;
  showAs: CalendarEvent['showAs'];
  organizer: { name: string; email: string } | null;
  attendees: { name: string; email: string }[];
  location: string;
  description: string;
  url: string | null;
}

type Raw = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** "diana.perez@empresa.com" → "Diana Perez". */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/\d+/g, '');
  return local.split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || email;
}

/** Fecha y hora con zona: V3 da "2026-10-29T08:00:00.0000000" en UTC (sin zona); Graph, { dateTime, timeZone }. */
function instant(v: unknown, alt?: unknown): string | null {
  const withZone = str(alt);
  if (withZone) return withZone;
  const raw = typeof v === 'object' && v ? str((v as Raw).dateTime) : str(v);
  if (!raw) return null;
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(/(\.\d{3})\d*$/, '$1')}Z`;
}

function person(v: unknown): { name: string; email: string } | null {
  if (typeof v === 'string') return v.includes('@') ? { name: nameFromEmail(v.trim()), email: v.trim() } : null;
  const e = (v as Raw | null)?.emailAddress as Raw | undefined;
  const email = str(e?.address);
  return email ? { name: str(e?.name) || nameFromEmail(email), email } : null;
}

function people(raw: Raw): { name: string; email: string }[] {
  const list: unknown[] = Array.isArray(raw.attendees)
    ? raw.attendees
    : [raw.requiredAttendees, raw.optionalAttendees].flatMap((s) => str(s).split(';'));
  const out: { name: string; email: string }[] = [];
  for (const p of list.map(person)) if (p && !out.some((o) => o.email.toLowerCase() === p.email.toLowerCase())) out.push(p);
  return out;
}

const SHOW_AS: Record<string, CalendarEvent['showAs']> = { tentative: 'tentative', free: 'free', oof: 'oof', workingelsewhere: 'free' };
const TEAMS = /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)\]]+/i;
const CANCELLED = /^(cancel(?:ed|led|ado|ada)|cancelado|cancelada)\s*:/i;

const htmlText = (html: string) => html
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Del JSON del flujo (la lista o `{ value: [...] }`) a reuniones recortadas. Ignora las canceladas y lo que no se entienda. */
export function trimOutlookEvents(json: unknown): OutlookEvent[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as Raw | null)?.value) ? (json as Raw).value as unknown[] : [];
  const out: OutlookEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Raw;
    const title = str(raw.subject).trim() || 'Reunión';
    const start = instant(raw.start, raw.startWithTimeZone);
    if (!start || raw.isCancelled === true || CANCELLED.test(title)) continue;
    const bodyObj = raw.body as Raw | string | undefined;
    const body = typeof bodyObj === 'string' ? bodyObj : str(bodyObj?.content);
    const location = typeof raw.location === 'object' && raw.location ? str((raw.location as Raw).displayName) : str(raw.location);
    const join = str((raw.onlineMeeting as Raw | undefined)?.joinUrl) || str(raw.onlineMeetingUrl)
      || TEAMS.exec(`${body} ${location}`)?.[0]?.replace(/&amp;/g, '&') || '';
    out.push({
      uid: str(raw.iCalUId) || str(raw.id) || `${start}|${title}`,
      title,
      start,
      end: instant(raw.end, raw.endWithTimeZone),
      allDay: raw.isAllDay === true,
      showAs: SHOW_AS[str(raw.showAs).toLowerCase()] ?? 'busy',
      organizer: person(raw.organizer),
      attendees: people(raw),
      location,
      description: (str(raw.bodyPreview) || htmlText(body)).slice(0, 2000),
      url: join || null,
    });
  }
  return out;
}

// Sin imports de valores: el servidor (Node sin compilar) importa este archivo.
const pad = (n: number) => String(n).padStart(2, '0');
const toISODate = (d: Date): ISODate => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Reuniones entre dos días (incluidos), en la zona horaria local, ordenadas por día y hora. */
export function outlookToCalendar(events: OutlookEvent[], from: ISODate, to: ISODate): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const s = new Date(e.start);
    if (Number.isNaN(s.getTime())) continue;
    // Las de día completo vienen a medianoche UTC: el día es el de la fecha, no el local.
    const date = e.allDay ? e.start.slice(0, 10) : toISODate(s);
    if (date < from || date > to) continue;
    const f = e.end ? new Date(e.end) : null;
    const attendees = [...e.attendees];
    if (e.organizer && !attendees.some((a) => a.email.toLowerCase() === e.organizer!.email.toLowerCase())) attendees.unshift(e.organizer);
    out.push({
      uid: e.uid,
      title: e.title,
      date,
      time: e.allDay ? null : hhmm(s),
      end: !e.allDay && f && !Number.isNaN(f.getTime()) && toISODate(f) === date ? hhmm(f) : null,
      attendees,
      organizer: e.organizer,
      description: e.description,
      location: e.location,
      url: e.url,
      showAs: e.showAs,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
}

/**
 * ¿Parece que el flujo de Power Automate se ha quedado en su tope? «Obtener vista de calendario de eventos (V3)» devuelve
 * como mucho 256 si no se cambia «Recuento superior» (hay que ponerlo a 1000). Lo subido son las reuniones sin las
 * canceladas, así que un calendario cortado se queda un poco por debajo: de 240 a 256.
 */
export const OUTLOOK_CAP = 256;
export const looksCapped = (count: number) => count >= OUTLOOK_CAP - 16 && count <= OUTLOOK_CAP;
