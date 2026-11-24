import { fold } from './text';
import { formatDay } from './dates';
import { stem, terms, type Hit } from './knowledge';
import type { Mention } from './notes';
import type { ActivityEntry, ISODate, Person, Task } from './types';

/**
 * Respuestas redactadas sin IA: de lo encontrado se elige la FRASE que mejor responde a la pregunta (la que tiene más
 * palabras buscadas, mejor si es corta y lleva la frase exacta) y se cita con su fuente. No se inventa ni se resume:
 * se escoge y se enseña de dónde sale.
 */

export interface Sentence { text: string; marks: [number, number][]; score: number }

/** Frases de un texto: por punto, interrogación o exclamación seguidos de espacio, y por líneas (listas, títulos…). */
export function sentences(text: string): string[] {
  return text.replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}¿¡"«(\d])/u))
    .map((s) => s.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').replace(/^#{1,6}\s+/, '').trim())
    .filter((s) => s.length >= 3);
}

/** Lo bien que una frase responde: proporción de palabras buscadas que tiene, con premio a la frase exacta y a las cortas. */
export function scoreSentence(sentence: string, q: string[], phrase = ''): Sentence {
  const words = [...sentence.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, t: stem(fold(m[0])) }));
  const hit = (t: string, w: string) => t === w || (w.length >= 4 && t.startsWith(w));
  const found = q.filter((w) => words.some((x) => hit(x.t, w)));
  const marks = words.filter((x) => q.some((w) => hit(x.t, w))).map((x) => [x.start, x.end] as [number, number]);
  let score = q.length ? found.length / q.length : 0;
  if (phrase.length > 3 && fold(sentence).includes(phrase)) score += 0.5;
  // Una frase de 40-200 caracteres se lee como respuesta; muy larga, menos.
  if (sentence.length > 260) score *= 0.8;
  return { text: sentence, marks, score };
}

export interface Extracted { sentence: Sentence; hit: Hit }

const ANSWER_SOURCES = new Set(['doc', 'note', 'list', 'person']);

/**
 * La mejor frase entre los primeros resultados (documentos, notas, Lista y fichas; las tareas ya se ven como lista).
 * Null si ninguna tiene al menos la mitad de las palabras buscadas (mejor no contestar que contestar mal).
 */
export function extractAnswer(hits: Hit[], query: string): Extracted | null {
  const q = [...new Set(terms(query))];
  if (!q.length) return null;
  const phrase = fold(query).replace(/[¿?¡!.,]/g, '').replace(/\s+/g, ' ').trim();
  let best: Extracted | null = null;
  const candidates = hits.filter((h) => ANSWER_SOURCES.has(h.chunk.source)).slice(0, 6);
  for (const [rank, hit] of candidates.entries()) {
    const text = hit.chunk.source === 'person' ? `${hit.chunk.title}: ${hit.chunk.text.split('\n').join('. ')}` : hit.chunk.text;
    for (const s of sentences(text)) {
      const scored = scoreSentence(s, q, phrase);
      // Un poco de ventaja para los que el buscador puso antes.
      scored.score *= 1 - rank * 0.04;
      if (!best || scored.score > best.sentence.score) best = { sentence: scored, hit };
    }
  }
  const min = q.length === 1 ? 1 : 0.5;
  return best && best.sentence.score >= min ? best : null;
}

/** «1 tarea» / «3 tareas». */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Lista legible: «a», «a y b», «a, b y c». */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

const quote = (t: string, max = 70) => `«${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}»`;

/** «Tienes 4 tareas: 2 atrasadas (la más antigua, «Revisar login», del 20 nov) y 1 bloqueada.» */
export function tasksSummary(tasks: Task[], what: string, today: ISODate, blocked = 0): string {
  if (!tasks.length) return `No hay ${what}.`;
  const overdue = tasks.filter((t) => t.status === 'todo' && t.due_date && t.due_date < today)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));
  const forToday = tasks.filter((t) => t.status === 'todo' && t.due_date === today);
  const parts: string[] = [];
  if (overdue.length) parts.push(`${count(overdue.length, 'atrasada', 'atrasadas')} (la más antigua, ${quote(overdue[0].title)}, del ${formatDay(overdue[0].due_date!, today)})`);
  if (forToday.length && forToday.length !== tasks.length) parts.push(`${forToday.length} para hoy`);
  if (blocked) parts.push(count(blocked, 'bloqueada', 'bloqueadas'));
  const head = tasks.length === 1 ? `Hay 1: ${quote(tasks[0].title)}` : `Hay ${tasks.length}`;
  return parts.length ? `${head}: ${listJoin(parts)}.` : `${head}.`;
}

/** «Esta semana has completado 5 tareas; la última, «Informe mensual».» */
export function doneSummary(entries: ActivityEntry[], period: string): string {
  if (!entries.length) return `No has completado nada ${period}.`;
  const last = [...entries].sort((a, b) => b.at.localeCompare(a.at))[0];
  return `${period[0].toUpperCase()}${period.slice(1)} has completado ${count(entries.length, 'tarea', 'tareas')}; la última, ${quote(last.title)}.`;
}

/** «Diana sale en 4 notas. Lo último, el 12 nov en «Acta sprint»: «…».» */
export function saidSummary(person: string, mentions: Mention[], today: ISODate): string {
  if (!mentions.length) return `${person} no aparece en ninguna nota.`;
  const notes = new Set(mentions.map((m) => m.note.id)).size;
  const last = mentions[0];
  return `${person} sale en ${count(notes, 'nota', 'notas')}. Lo último, ${formatDay(last.note.date, today)} en ${quote(last.note.title, 50)}: ${quote(last.text, 160)}.`;
}

/** «Tienes 2 temas pendientes con Luis: «a» y «b».» */
export function topicsSummary(person: string, topics: Task[]): string {
  if (!topics.length) return `No tienes temas pendientes con ${person}.`;
  const shown = topics.slice(0, 3).map((t) => quote(t.title, 50));
  return `Tienes ${count(topics.length, 'tema pendiente', 'temas pendientes')} con ${person}: ${listJoin(shown)}${topics.length > 3 ? '…' : ''}.`;
}

/** «Ana Ruiz es PO de Imagin. Tiene 3 tareas pendientes contigo. Su email es ana@…» */
export function personSummary(name: string, card: Person | undefined, open: number): string {
  const parts = [card?.role ? `${name} es ${card.role}.` : `${name} no tiene rol en su ficha.`];
  parts.push(open ? `Tiene ${count(open, 'tarea pendiente', 'tareas pendientes')} en tu Marea.` : 'No tiene tareas pendientes en tu Marea.');
  if (card?.email) parts.push(`Su email es ${card.email}.`);
  return parts.join(' ');
}
