import { addDays, toISODate, weekdayOf } from './dates';
import type { ISODate } from './types';

/** Reunión leída de un archivo .ics (Outlook, Teams, Google Calendar…). */
export interface CalendarEvent {
  uid: string;
  title: string;
  /** Día local de la reunión. */
  date: ISODate;
  /** Hora local "HH:MM" (null en eventos de día completo). */
  time: string | null;
  /** Hora local de fin "HH:MM" (null si no la trae, es de día completo o acaba otro día). */
  end: string | null;
  attendees: { name: string; email: string }[];
  organizer: { name: string; email: string } | null;
  description: string;
  location: string;
  /** Enlace para unirse (Teams u otro), si lo trae. */
  url: string | null;
  /** Cómo se muestra en Outlook: ocupado, provisional (sin confirmar), libre o fuera de la oficina. */
  showAs: 'busy' | 'tentative' | 'free' | 'oof';
  /** Nombre del otro calendario (p. ej. «La Caixa») si no es el de Outlook; sale con otro color. */
  calendar?: string;
}

interface Prop { name: string; params: Record<string, string>; value: string }

/** Une las líneas plegadas (las que empiezan por espacio o tabulador continúan la anterior). */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseProp(line: string): Prop | null {
  // NOMBRE;PARAM=valor;PARAM="valor:con:dos puntos":VALOR
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    if (line[i] === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescape = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/**
 * Fecha y hora locales de un DTSTART. Con "Z" es UTC y se pasa a la hora local; con TZID se toma
 * tal cual (lo normal es que sea la zona de la propia usuaria); sin hora es un día completo.
 */
function parseDate(p: Prop): { date: ISODate; time: string | null } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return { date: `${y}-${mo}-${d}`, time: null };
  if (z) {
    const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return { date: toISODate(local), time: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}` };
  }
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

function person(p: Prop): { name: string; email: string } {
  const email = p.value.replace(/^mailto:/i, '').trim();
  return { name: p.params.CN?.trim() || email.split('@')[0], email };
}

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Fechas de una regla RRULE sencilla (DAILY, WEEKLY con BYDAY, MONTHLY) dentro de [from, to]. */
function expandRule(rule: string, start: ISODate, from: ISODate, to: ISODate, exdates: Set<string>): ISODate[] {
  const r = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]));
  const interval = Number(r.INTERVAL ?? 1);
  const until = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : null;
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const days = r.BYDAY ? r.BYDAY.split(',').map((d: string) => BYDAY[d.slice(-2)]).filter((d: number | undefined) => d !== undefined) : [weekdayOf(start)];
  const out: ISODate[] = [];
  let n = 0;
  // Recorre día a día desde el inicio (las series de reuniones son cortas o se cortan en `to`).
  for (let d = start; d <= to && n < count && (!until || d <= until); d = addDays(d, 1)) {
    const diff = Math.round((Date.parse(d) - Date.parse(start)) / 86_400_000);
    let hit = false;
    if (r.FREQ === 'DAILY') hit = diff % interval === 0;
    else if (r.FREQ === 'WEEKLY') hit = days.includes(weekdayOf(d)) && Math.floor(diff / 7) % interval === 0;
    else if (r.FREQ === 'MONTHLY') hit = d.slice(8) === start.slice(8);
    if (!hit) continue;
    n++;
    if (d >= from && !exdates.has(d)) out.push(d);
  }
  return out;
}

/**
 * Lee las reuniones de un .ics. Las recurrentes se expanden dentro de la ventana [from, to];
 * los eventos cancelados se ignoran.
 */
export function parseIcs(text: string, from: ISODate, to: ISODate): CalendarEvent[] {
  const lines = unfold(text);
  const events: CalendarEvent[] = [];
  let props: Prop[] | null = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { props = []; continue; }
    if (line.startsWith('END:VEVENT')) {
      if (props) events.push(...toEvents(props, from, to));
      props = null;
      continue;
    }
    if (props) { const p = parseProp(line); if (p) props.push(p); }
  }
  // Una ocurrencia modificada (RECURRENCE-ID) sustituye a la de la serie del mismo día.
  const seen = new Map<string, CalendarEvent>();
  for (const e of events) seen.set(`${e.uid}|${e.date}`, e);
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
}

function toEvents(props: Prop[], from: ISODate, to: ISODate): CalendarEvent[] {
  const get = (n: string) => props.find((p) => p.name === n);
  if (get('STATUS')?.value.toUpperCase() === 'CANCELLED') return [];
  const start = get('DTSTART') ? parseDate(get('DTSTART')!) : null;
  if (!start) return [];
  const finish = get('DTEND') ? parseDate(get('DTEND')!) : null;
  const end = start.time && finish?.time && finish.date === start.date ? finish.time : null;
  const description = unescape(get('DESCRIPTION')?.value ?? '');
  const location = unescape(get('LOCATION')?.value ?? '');
  const teams = get('X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value
    ?? /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"<>)\]]+/i.exec(`${description} ${location}`)?.[0]
    ?? get('URL')?.value ?? null;
  const organizerProp = get('ORGANIZER');
  const organizer = organizerProp ? person(organizerProp) : null;
  const attendees = props.filter((p) => p.name === 'ATTENDEE').map(person);
  if (organizer && !attendees.some((a) => a.email.toLowerCase() === organizer.email.toLowerCase())) attendees.unshift(organizer);
  const busy = (get('X-MICROSOFT-CDO-BUSYSTATUS')?.value ?? '').toUpperCase();
  const showAs: CalendarEvent['showAs'] = busy === 'TENTATIVE' ? 'tentative' : busy === 'OOF' ? 'oof'
    : busy === 'FREE' || (!busy && get('TRANSP')?.value.toUpperCase() === 'TRANSPARENT') ? 'free' : 'busy';
  const base = {
    uid: get('UID')?.value ?? `${start.date}-${get('SUMMARY')?.value}`,
    title: unescape(get('SUMMARY')?.value ?? 'Reunión'),
    time: start.time, end, attendees, organizer, description, location, url: teams, showAs,
  };
  const rrule = get('RRULE')?.value;
  const recurrenceId = get('RECURRENCE-ID');
  if (rrule && !recurrenceId) {
    const exdates = new Set(props.filter((p) => p.name === 'EXDATE').flatMap((p) => p.value.split(',').map((v) => parseDate({ ...p, value: v })?.date ?? '')));
    return expandRule(rrule, start.date, from, to, exdates).map((date) => ({ ...base, date }));
  }
  return start.date >= from && start.date <= to ? [{ ...base, date: start.date }] : [];
}
