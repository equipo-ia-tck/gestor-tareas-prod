import { actionItems, plainLine } from './markdown';
import type { Note, Task } from './types';

/** Líneas con contenido de una sección del acta ("Decisiones", "Notas"…). */
function sectionLines(body: string, name: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const h = /^\s*#{1,3}\s+(.*)$/.exec(raw);
    if (h) { inside = h[1].trim().toLowerCase().startsWith(name.toLowerCase()); continue; }
    if (!inside) continue;
    const t = plainLine(raw).replace(/\[\[t:[\w-]+\]\]/g, '').trim();
    if (t && !/^\[[ xX]\]/.test(t)) out.push(t);
  }
  return out;
}

/** Quita la marca @ de las menciones ("@Diana-Pérez" → "Diana Pérez"). */
const unmention = (s: string) => s.replace(/(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_\-.]*[\p{L}\p{N}_])/gu, (_, n: string) => n.replace(/-/g, ' '));

/**
 * Resumen del acta en texto plano para pegar en Teams (o en un correo): asistentes, decisiones
 * y acciones con su estado (si la acción está enlazada a una tarea, manda el estado de la tarea).
 */
export function meetingSummary(note: Note, tasks: Map<string, Task> = new Map()): string {
  const date = note.date.split('-').reverse().join('/');
  const out = [`${note.title || 'Reunión'} · ${date}`];
  if (note.people.length) out.push(`Asistentes: ${note.people.join(', ')}`);
  const decisions = sectionLines(note.body, 'Decisi');
  if (decisions.length) out.push('', 'Decisiones:', ...decisions.map((d) => `• ${unmention(d)}`));
  const actions = actionItems(note.body);
  if (actions.length) {
    out.push('', 'Acciones:');
    for (const a of actions) {
      const task = a.taskId ? tasks.get(a.taskId) : undefined;
      const done = task ? task.status === 'done' : a.checked;
      const due = task?.due_date ? ` (${task.due_date.split('-').reverse().slice(0, 2).join('/')})` : '';
      out.push(`${done ? '☑' : '☐'} ${unmention(plainLine(`- ${a.text}`))}${due}`);
    }
  }
  return out.join('\n');
}

/** Enlace para abrir en Teams un chat con esas personas, con tema y mensaje precargados. */
export function teamsChatUrl(emails: string[], topic?: string, message?: string): string | null {
  const valid = emails.map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (!valid.length) return null;
  const params = new URLSearchParams({ users: valid.join(',') });
  if (topic && valid.length > 1) params.set('topicName', topic.slice(0, 100));
  // Teams admite mensajes precargados; se acortan para no superar el límite de longitud de la URL.
  if (message) params.set('message', message.length > 1200 ? `${message.slice(0, 1190)}…` : message);
  return `https://teams.microsoft.com/l/chat/0/0?${params.toString()}`;
}

/** Enlace de una reunión de Teams dentro de un texto (descripción o ubicación del evento). */
export function findTeamsLink(text: string): string | null {
  return /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"<>)\]]+/i.exec(text)?.[0] ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Fecha y hora locales en ISO con su desfase ("2026-10-29T10:00:00+01:00"), como pide Teams. */
export function localIsoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/**
 * Enlace que abre en Teams el formulario de una reunión nueva ya rellenado (título, inicio, fin, asistentes y
 * descripción). Sin permisos: la reunión se crea en el calendario real cuando la persona pulsa Enviar en Teams.
 */
export function teamsMeetingUrl(m: { title: string; date: string; time: string; minutes: number; attendees: string[]; content?: string }): string {
  const start = new Date(`${m.date}T${m.time}:00`);
  const end = new Date(start.getTime() + m.minutes * 60_000);
  const params = new URLSearchParams({ subject: m.title.trim() || 'Reunión', startTime: localIsoWithOffset(start), endTime: localIsoWithOffset(end) });
  const emails = m.attendees.map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (emails.length) params.set('attendees', emails.join(','));
  if (m.content?.trim()) params.set('content', m.content.length > 1200 ? `${m.content.slice(0, 1190)}…` : m.content);
  return `https://teams.microsoft.com/l/meeting/new?${params.toString()}`;
}

/**
 * Personas con email para invitar: las de las reuniones del calendario y las fichas con email, sin repetir email y
 * ordenadas por las veces que aparecen en reuniones.
 */
export function meetingContacts(meetings: { attendees: { name: string; email: string }[] }[], cards: { name: string; email?: string }[]): { name: string; email: string }[] {
  const map = new Map<string, { name: string; email: string; n: number }>();
  for (const c of cards) if (c.email) map.set(c.email.toLowerCase(), { name: c.name, email: c.email, n: 0 });
  for (const m of meetings) {
    for (const a of m.attendees) {
      if (!a.email.includes('@')) continue;
      const k = a.email.toLowerCase();
      const e = map.get(k) ?? { name: a.name, email: a.email, n: 0 };
      e.n++;
      map.set(k, e);
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'es')).map(({ name, email }) => ({ name, email }));
}

/**
 * Enlace que abre directamente la app de Teams (`msteams:`), sin pasar por una pestaña del navegador. Solo para enlaces
 * de teams.microsoft.com; los demás se devuelven tal cual.
 */
export function teamsAppUrl(url: string): string {
  return url.replace(/^https:\/\/teams\.microsoft\.com\//i, 'msteams:/');
}

/**
 * Enlace que abre la reunión en Teams web sin lanzar la app de escritorio. El enlace normal pasa por la página
 * «launcher» de Teams, que abre la app si está instalada (con la cuenta de WPP, que no deja entrar en las reuniones de
 * otra empresa). Con `msLaunch=false` y `suppressPrompt=true` esa página va directa a «Continuar en este navegador».
 * Solo para reuniones de teams.microsoft.com (`/l/meetup-join/…`); los demás enlaces se devuelven tal cual.
 */
export function teamsWebUrl(url: string): string {
  const m = /^https:\/\/teams\.microsoft\.com(\/l\/meetup-join\/.+)$/i.exec(url);
  if (!m) return url;
  const params = new URLSearchParams({
    url: `/_#${m[1]}`,
    type: 'meetup-join',
    directDl: 'true',
    msLaunch: 'false',
    enableMobilePage: 'true',
    suppressPrompt: 'true',
  });
  return `https://teams.microsoft.com/dl/launcher/launcher.html?${params.toString()}`;
}
