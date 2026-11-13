import { firstOccurrence } from '../domain/recurrence';
import { nameKey } from '../domain/text';
import { resolveProjectToken } from '../domain/projects';
import { typeForPrefix } from '../domain/workflows';
import type { ISODate, Priority, RecurrenceRule } from '../domain/types';
import { estimateMinutes, findDate, findRecurrence, findReminder, SYMBOL_PATTERNS, type Match } from './patterns';
import { addDays } from '../domain/dates';
import { atLocal } from '../domain/reminders';
import { tokenKey, type CaptureContext, type ParseCapture, type ParsedTask, type Token, type TokenKind } from './types';

/**
 * Convierte el texto de la barra de captura en tareas.
 * Varias tareas se separan con ";" o saltos de línea.
 */
export const parseCapture: ParseCapture = (text, ctx) => {
  const out: ParsedTask[] = [];
  for (const m of text.matchAll(/[^;\n]+/g)) {
    if (m[0].trim()) out.push(parseSegment(m[0], m.index, ctx));
  }
  return out;
};

const SINGLE: TokenKind[] = ['project', 'priority', 'estimate', 'key', 'release'];

function parseSegment(seg: string, offset: number, ctx: CaptureContext): ParsedTask {
  const ignore = new Set(ctx.ignore ?? []);
  const reserved: [number, number][] = [];
  const tokens: Token[] = [];
  const blocked = (s: number, e: number) => reserved.some(([rs, re]) => s < re && e > rs);
  const reserve = (s: number, e: number) => reserved.push([s, e]);

  let project: ParsedTask['project'] = null;
  const people: string[] = [];
  /** Nombre normalizado de cada token @persona, por posición, para el título. */
  const personNames = new Map<number, string>();
  const tags: string[] = [];
  let priority: Priority | null = null;
  let estimate: number | null = null;
  let externalId: string | null = null;
  let typeId: string | null = null;
  let release: ParsedTask['release'] = null;

  const addToken = (kind: TokenKind, start: number, end: number): boolean => {
    const text = seg.slice(start, end);
    reserve(start, end);
    if (ignore.has(tokenKey({ kind, text }))) return false;
    if (SINGLE.includes(kind) && tokens.some((t) => t.kind === kind)) return false;
    tokens.push({ kind, start, end, text });
    return true;
  };

  // 1. Tokens con símbolo: no son ambiguos y tienen preferencia.
  for (const kind of ['project', 'person', 'priority', 'estimate', 'tag', 'key', 'release'] as const) {
    const re = SYMBOL_PATTERNS[kind];
    re.lastIndex = 0;
    for (const m of seg.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (blocked(start, end)) continue;
      if (kind === 'estimate') {
        const min = estimateMinutes(m as RegExpExecArray);
        if (min === null) continue; // mal escrito: se queda como texto
        if (addToken(kind, start, end)) estimate = min;
        continue;
      }
      if (!addToken(kind, start, end)) continue;
      const value = m[1];
      if (kind === 'project') {
        const all = ctx.projects.map((p) => ({ ...p, parent_id: p.parent_id ?? null, color: '', archived: false, created_at: '' }));
        const found = resolveProjectToken(value, all);
        if (found) project = { id: found.id, name: found.name };
        else {
          // "#padre/nuevo": se creará como subproyecto si el padre existe.
          const slash = value.lastIndexOf('/');
          const parent = slash > 0 ? resolveProjectToken(value.slice(0, slash), all) : undefined;
          project = { id: null, name: (slash > 0 ? value.slice(slash + 1) : value).replace(/-/g, ' '), parent_id: parent?.id ?? null };
        }
      } else if (kind === 'person') {
        const known = ctx.people.find((p) => nameKey(p) === nameKey(value)) ?? value.replace(/-/g, ' ');
        personNames.set(start, known);
        if (!people.some((p) => nameKey(p) === nameKey(known))) people.push(known);
      } else if (kind === 'priority') {
        priority = Number(value) as Priority;
      } else if (kind === 'tag') {
        if (!tags.includes(value)) tags.push(value);
      } else if (kind === 'key') {
        externalId = m[0];
        typeId = ctx.types ? typeForPrefix(ctx.types, value)?.id ?? null : null;
      } else if (kind === 'release') {
        const found = ctx.releases?.find((r) => nameKey(r.name) === nameKey(value));
        release = found ? { id: found.id, name: found.name } : { id: null, name: value };
      }
    }
  }

  // 2. Recurrencia y 3. fecha. Si un fragmento se descarta, se reserva como texto y se busca otro.
  const findWords = <T,>(kind: TokenKind, find: (b: typeof blocked) => Match<T> | null): Match<T> | null => {
    for (;;) {
      const m = find(blocked);
      if (!m) return null;
      if (addToken(kind, m.start, m.end)) return m;
    }
  };

  // El recordatorio va antes que la fecha para que "a las 9" no se lea como otra cosa.
  const reminderMatch = findWords('reminder', (b) => findReminder(seg, b));
  const recurrenceMatch = findWords('recurrence', (b) => findRecurrence(seg, ctx.today, b));
  const dateMatch = findWords('date', (b) => findDate(seg, ctx.today, b));
  let recurrence: RecurrenceRule | null = recurrenceMatch?.value ?? null;

  // "cada mes" / "cada semana" junto a una fecha: se ancla en esa fecha, no en hoy.
  if (recurrenceMatch && dateMatch) {
    const again = findRecurrence(seg.slice(recurrenceMatch.start, recurrenceMatch.end), dateMatch.value, () => false);
    if (again) recurrence = again.value;
  }

  let due: ISODate | null = dateMatch?.value ?? null;
  if (!due && recurrence) due = firstOccurrence(recurrence, ctx.today);

  // Aviso el día de la tarea (o hoy); si sin fecha la hora ya pasó, mañana.
  let remindAt: string | null = null;
  if (reminderMatch) {
    const { h, m } = reminderMatch.value;
    remindAt = atLocal(due ?? ctx.today, h, m);
    if (!due && remindAt <= (ctx.now ?? new Date()).toISOString()) remindAt = atLocal(addDays(ctx.today, 1), h, m);
  }

  return {
    title: buildTitle(seg, tokens, personNames),
    raw_input: seg.trim(),
    due_date: due,
    project,
    people,
    tags,
    priority,
    estimated_minutes: estimate,
    recurrence,
    external_id: externalId,
    type_id: typeId,
    release,
    remind_at: remindAt,
    tokens: tokens
      .map((t) => ({ ...t, start: t.start + offset, end: t.end + offset }))
      .sort((a, b) => a.start - b.start),
  };
}

const KEEPS_PERSON = /(?:^|\s)(?:a|al|con|para|de|del|según|y|e|o|u|ni|por|sobre|entre|que)\s+$/i;

/** Quita los tokens del texto. Las personas tras preposición se quedan como nombre ("a @Diana" → "a Diana"). */
function buildTitle(seg: string, tokens: Token[], personNames: Map<number, string>): string {
  let out = '';
  let pos = 0;
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    out += seg.slice(pos, t.start);
    // La persona se queda en el título solo si la frase la necesita ("a @Diana", "con @Luis");
    // si va suelta ("revisar login @Diana") es solo un dato y se quita.
    if (t.kind === 'person' && KEEPS_PERSON.test(seg.slice(0, t.start))) out += personNames.get(t.start) ?? t.text.slice(1);
    pos = t.end;
  }
  out += seg.slice(pos);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;])/g, '$1')
    .replace(/^[\s,.:;–-]+|[\s,:;–-]+$/g, '')
    .trim();
}
