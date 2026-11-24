import { findDate } from '../parser/patterns';
import { parseDateText } from '../parser/fields';
import type { MsListField } from './msListParse';
import { TITLE_FIELD } from './msListParse';
import { fold } from './text';
import type { ISODate } from './types';

/**
 * «Crear con petición» en la Lista: de una frase saca el título y las columnas, como el de Rally pero con las columnas de
 * cada lista (sin IA ni servicios externos). Reconoce:
 *
 * - **«Columna valor»** (o «columna: valor», «columna es valor»): «estado en curso», «prioridad tarea 1», «equipo
 *   responsable DS&A», «fecha estimada el viernes», «comentarios: falta validar en PRE». Llega hasta la siguiente columna.
 * - **Opciones sueltas** que solo están en una columna («backlog», «DS&A», «Completada»), sin decir la columna.
 * - **Una fecha suelta** («para el viernes», «el 15 de diciembre») si la lista tiene una sola columna de fecha.
 * - **El título**: entre comillas, o lo que queda al principio.
 *
 * Lo que no entiende va a `unknown`. Las personas y las búsquedas no se pueden rellenar desde Marea.
 */

export interface ListRequest {
  /** Nombre visible de la columna → valor, listo para el formulario («Título» incluido). */
  values: Record<string, string>;
  unknown: string[];
}

const LEAD = /^\s*(?:(?:crear?|crea|añad[ei]r?|añade|nuev[oa]|alta(?:\s+de)?|elemento|item|ítem|tarea|fila|registro|en\s+la\s+lista)\b[\s:,-]*)+/i;
const FILLER = /^(?:[\s,;:=.-]|\b(?:es|en|a|de|del|con|y|el|la|los|las|que|sea|igual\s+a)\b)+|(?:[\s,;.-]|\b(?:y|con|en|de|para|el|la)\b)+$/gi;
const tidy = (s: string) => s.replace(FILLER, '').replace(/\s+/g, ' ').trim();
/** En los textos libres solo se quitan los signos de alrededor (las palabras pueden ser parte del texto). */
const tidyText = (s: string) => s.replace(/^[\s,;:=.-]+|[\s,;.-]+$/g, '').replace(/^(?:es|son)\s+/i, '').replace(/\s+/g, ' ').trim();

/** Texto plegado (sin tildes, en minúsculas) con el índice de cada letra en el original. */
function folded(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (const ch of f) { out += ch; at.push(i); }
  }
  at.push(text.length);
  return { text: out, at };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** La palabra o frase entera (no dentro de otra palabra). */
const wordRe = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(fold(s).trim())}(?![\\p{L}\\p{N}])`, 'gu');

/** La opción más parecida: igual, empieza por o contiene (sin tildes ni mayúsculas). */
export function bestChoice(choices: string[], value: string): string | null {
  const v = fold(value).replace(/\s+/g, ' ').trim();
  if (!v) return null;
  const score = (c: string) => {
    const k = fold(c).trim();
    return k === v ? 0 : k.startsWith(v) ? 1 : v.startsWith(k) ? 2 : k.includes(v) ? 3 : 9;
  };
  return choices.map((c) => ({ c, s: score(c) })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || a.c.length - b.c.length)[0]?.c ?? null;
}

/** Valor de una columna a partir de lo escrito, según su tipo; null si no encaja. */
function valueFor(field: MsListField, raw: string, today: ISODate): string | null {
  if (field.type === 'Text' || field.type === 'Note') return tidyText(raw) || null;
  const v = tidy(raw);
  if (!v) return null;
  switch (field.type) {
    case 'Choice':
      return field.choices.length ? bestChoice(field.choices, v) : v;
    case 'MultiChoice': {
      const parts = v.split(/\s*(?:,|\by\b)\s*/i).map((p) => bestChoice(field.choices, p)).filter((p): p is string => !!p);
      return parts.length ? [...new Set(parts)].sort((a, b) => field.choices.indexOf(a) - field.choices.indexOf(b)).join(', ') : null;
    }
    case 'Number':
    case 'Currency':
      return /-?\d+(?:[.,]\d+)?/.exec(v)?.[0].replace(',', '.') ?? null;
    case 'Boolean':
      return /^(s[ií]|true|yes|vale)\b/i.test(v) ? 'Sí' : /^(no|false)\b/i.test(v) ? 'No' : null;
    case 'DateTime': {
      const d = parseDateText(v.replace(/^(?:para|hasta|antes\s+del?)\s+/i, ''), today);
      return d.ok && d.value ? d.value : null;
    }
    default:
      return v;
  }
}

export function parseListRequest(input: string, fields: MsListField[], today: ISODate): ListRequest {
  const values: Record<string, string> = {};
  const unknown: string[] = [];
  let text = input.replace(/\s+/g, ' ').trim();

  // Título entre comillas, en cualquier sitio.
  const quoted = /["“«]([^"”»]+)["”»]/.exec(text);
  if (quoted) {
    values[TITLE_FIELD] = quoted[1].trim();
    text = (text.slice(0, quoted.index) + ' ' + text.slice(quoted.index + quoted[0].length)).trim();
  }
  text = text.replace(LEAD, '');

  const editable = fields.filter((f) => f.label !== TITLE_FIELD);
  // Dónde se nombra cada columna, por su nombre o por su primera palabra si ninguna otra empieza igual («prioridad» =
  // «Prioridad Tarea»). Los nombres más largos primero: «Tarea madre» antes que «Tarea».
  const firstWord = (label: string) => fold(label).trim().split(/\s+/)[0];
  const names = editable.flatMap((field) => {
    const w = firstWord(field.label);
    const unique = w.length >= 4 && w !== fold(field.label).trim() && editable.filter((x) => firstWord(x.label) === w).length === 1;
    return unique ? [{ field, name: field.label }, { field, name: w }] : [{ field, name: field.label }];
  }).sort((a, b) => b.name.length - a.name.length);
  const f = folded(text);
  const marks: { field: MsListField; start: number; end: number }[] = [];
  for (const { field, name } of names) {
    if (marks.some((x) => x.field === field)) continue;
    for (const m of f.text.matchAll(wordRe(name))) {
      const start = f.at[m.index!];
      const end = f.at[m.index! + m[0].length];
      if (marks.some((x) => start < x.end && end > x.start)) continue;
      marks.push({ field, start, end });
      break;
    }
  }
  marks.sort((a, b) => a.start - b.start);

  let head = marks.length ? text.slice(0, marks[0].start) : text;
  marks.forEach((m, i) => {
    const raw = text.slice(m.end, marks[i + 1]?.start ?? text.length);
    if (!m.field.editable) { if (tidy(raw)) unknown.push(`${m.field.label} ${tidy(raw)} (no se puede rellenar desde Marea)`); return; }
    const value = valueFor(m.field, raw, today);
    if (value) values[m.field.label] = value;
    else if (tidy(raw)) unknown.push(`${m.field.label} ${tidy(raw)}`);
  });

  // Opciones sueltas en lo que queda: solo si esa opción está en una sola columna (y tiene 3 letras o más).
  const owners = new Map<string, MsListField[]>();
  for (const field of editable) {
    if (!field.editable || !['Choice', 'MultiChoice'].includes(field.type)) continue;
    for (const c of field.choices) if (fold(c).trim().length >= 3) owners.set(c, [...(owners.get(c) ?? []), field]);
  }
  for (const [choice, list] of [...owners].sort((a, b) => b[0].length - a[0].length)) {
    if (list.length !== 1 || values[list[0].label]) continue;
    const fh = folded(head);
    const m = wordRe(choice).exec(fh.text);
    if (!m) continue;
    values[list[0].label] = choice;
    head = head.slice(0, fh.at[m.index]) + ' ' + head.slice(fh.at[m.index + m[0].length]);
  }

  // Una fecha suelta, si la lista tiene una sola columna de fecha y aún no se ha dicho.
  const dates = editable.filter((x) => x.editable && x.type === 'DateTime');
  if (dates.length === 1 && !values[dates[0].label]) {
    const d = findDate(head, today, () => false);
    if (d) {
      values[dates[0].label] = d.value;
      head = (head.slice(0, d.start).replace(/\b(?:para|hasta|antes\s+del?)\s*$/i, '') + ' ' + head.slice(d.end));
    }
  }

  const rest = tidy(head);
  if (!values[TITLE_FIELD]) { if (rest) values[TITLE_FIELD] = rest[0].toUpperCase() + rest.slice(1); }
  else if (rest) unknown.push(rest);
  return { values, unknown };
}
