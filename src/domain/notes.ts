import { plainLine, sectionOf } from './markdown';
import { resolveProjectToken } from './projects';
import { fold, nameKey } from './text';
import type { ISODate, Note, Project } from './types';

export const isLiveNote = (n: Note) => !n.deleted_at;

/** Plantilla de acta: asistentes, contexto, notas, decisiones y acciones. */
export function meetingTemplate(attendees: string[] = []): string {
  const who = attendees.map((a) => `@${a.replace(/\s+/g, '-')}`).join(' ');
  return [
    `**Asistentes:** ${who}`,
    '',
    '## Contexto',
    '',
    '',
    '## Notas',
    '- ',
    '',
    '## Decisiones',
    '- ',
    '',
    '## Acciones',
    '- [ ] ',
  ].join('\n');
}

export interface Mention {
  note: Note;
  line: number;
  /** Línea en texto plano. */
  text: string;
  /** Sección del acta donde aparece ("Decisiones", "Notas"…). */
  section: string | null;
}

/**
 * "Quién dijo qué": líneas de notas que mencionan a la persona (excepto la de asistentes),
 * las más recientes primero.
 */
export function mentionsOf(person: string, notes: Note[]): Mention[] {
  const key = nameKey(person);
  const re = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_\-.]*[\p{L}\p{N}_])/gu;
  const out: Mention[] = [];
  for (const note of notes) {
    if (!isLiveNote(note)) continue;
    note.body.split('\n').forEach((raw, line) => {
      if (/^\s*\*\*asistentes:?\*\*/i.test(raw)) return;
      const hits = [...raw.matchAll(re)].some((m) => nameKey(m[1]) === key);
      if (!hits) return;
      const text = plainLine(raw);
      if (text.replace(re, '').trim().length < 2) return; // línea con solo la mención
      out.push({ note, line, text, section: sectionOf(note.body, line) });
    });
  }
  return out.sort((a, b) => b.note.date.localeCompare(a.note.date) || a.line - b.line);
}

const MENTION = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_\-.]*[\p{L}\p{N}_])/gu;
const PROJECT_TAG = /(?<![\p{L}\p{N}_&/])#([\p{L}\p{N}_\-./]*[\p{L}\p{N}_])/gu;
const LINE_TASK = /\[\[t:([\w-]+)\]\]/;

/** Una línea de nota con @personas o #proyectos: se ve en la persona y en el proyecto y se puede pasar a tarea. */
export interface NoteLine extends Mention {
  /** Personas mencionadas tal como se escribieron ("Diana-Pérez" → "Diana Pérez"). */
  people: string[];
  /** Proyectos mencionados con #, ya resueltos (los # que no son un proyecto no cuentan). */
  projectIds: string[];
  /** Tarea creada desde la línea ([[t:id]]), si la hay. */
  taskId: string | null;
}

/**
 * Líneas de las notas que mencionan @personas o #proyectos (excepto la de asistentes y las que solo tienen la
 * mención), las más recientes primero.
 */
export function noteLines(notes: Note[], projects: Project[]): NoteLine[] {
  const out: NoteLine[] = [];
  for (const note of notes) {
    if (!isLiveNote(note)) continue;
    note.body.split('\n').forEach((raw, line) => {
      if (/^\s*\*\*asistentes:?\*\*/i.test(raw)) return;
      const people = [...raw.matchAll(MENTION)].map((m) => m[1].replace(/-/g, ' '));
      const projectIds = [...new Set([...raw.matchAll(PROJECT_TAG)]
        .map((m) => resolveProjectToken(m[1], projects)?.id).filter((id): id is string => !!id))];
      if (!people.length && !projectIds.length) return;
      const text = plainLine(raw);
      if (text.replace(MENTION, '').replace(PROJECT_TAG, '').trim().length < 2) return;
      out.push({ note, line, text, section: sectionOf(note.body, line), people, projectIds, taskId: LINE_TASK.exec(raw)?.[1] ?? null });
    });
  }
  return out.sort((a, b) => b.note.date.localeCompare(a.note.date) || a.line - b.line);
}

/**
 * Lo que se ha dicho de un proyecto: líneas que lo mencionan con # (a él o a un subproyecto) y líneas con @persona de
 * las notas del proyecto.
 */
export function projectLines(scope: Set<string>, notes: Note[], projects: Project[]): NoteLine[] {
  return noteLines(notes, projects).filter((l) => l.projectIds.some((id) => scope.has(id))
    || (l.people.length > 0 && l.note.project_id !== null && scope.has(l.note.project_id)));
}

/** Notas que enlazan una tarea con [[t:id]] (contexto de dónde salió). */
export const notesLinkingTask = (taskId: string, notes: Note[]) =>
  notes.filter((n) => isLiveNote(n) && n.body.includes(`[[t:${taskId}]]`));

/** Reuniones en las que estuvo (o se mencionó) a la persona. */
export const meetingsWith = (person: string, notes: Note[]) =>
  notes
    .filter((n) => isLiveNote(n) && n.people.some((p) => nameKey(p) === nameKey(person)))
    .sort((a, b) => b.date.localeCompare(a.date));

export function matchesNote(n: Note, words: string[]): boolean {
  if (!isLiveNote(n) || !words.length) return false;
  const hay = fold(`${n.title} ${n.body}`);
  return words.every((w) => hay.includes(w));
}

/** Primera línea con contenido (resumen en listas). */
export function noteExcerpt(n: Note): string {
  for (const raw of n.body.split('\n')) {
    if (/^\s*#{1,3}\s/.test(raw) || /^\s*\*\*asistentes/i.test(raw)) continue;
    const t = plainLine(raw);
    if (t.length > 1) return t;
  }
  return '';
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date.localeCompare(a.date) || b.updated_at.localeCompare(a.updated_at));
}

export const defaultNoteTitle = (kind: Note['kind'], date: ISODate) =>
  kind === 'meeting' ? `Reunión ${date.split('-').reverse().join('/')}` : 'Nota sin título';

/** Notas de un elemento (US, TS, tarea…), las más recientes primero. */
export const notesForTask = (taskId: string, notes: Note[]) =>
  notes
    .filter((n) => isLiveNote(n) && n.task_id === taskId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));

/**
 * Notas de elementos agrupadas por elemento, para la vista de proyecto: cada grupo ordenado por
 * fecha y los grupos por su nota más reciente.
 */
export function notesByTask(taskIds: Set<string>, notes: Note[]): { taskId: string; notes: Note[] }[] {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    if (!isLiveNote(n) || !n.task_id || !taskIds.has(n.task_id)) continue;
    groups.set(n.task_id, [...(groups.get(n.task_id) ?? []), n]);
  }
  return [...groups]
    .map(([taskId, list]) => ({ taskId, notes: list.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)) }))
    .sort((a, b) => b.notes[0].date.localeCompare(a.notes[0].date) || b.notes[0].created_at.localeCompare(a.notes[0].created_at));
}

/** Clave de orden de una página: la manual o, si no tiene, su fecha de creación. */
const pageKey = (n: Note) => n.sort_order ?? Date.parse(n.created_at) ?? 0;

/** Páginas de una sección en su orden (manual, como en OneNote). */
export const sortPages = (notes: Note[]) => [...notes].sort((a, b) => pageKey(a) - pageKey(b) || a.created_at.localeCompare(b.created_at));

/**
 * Nuevo orden al soltar la página `id` delante de `beforeId` (o al final si es null).
 * Devuelve los cambios de `sort_order` necesarios (solo los que cambian).
 */
export function reorderPages(pages: Note[], id: string, beforeId: string | null): { id: string; sort_order: number }[] {
  const order = sortPages(pages).filter((n) => n.id !== id);
  const moved = pages.find((n) => n.id === id);
  if (!moved) return [];
  const at = beforeId ? order.findIndex((n) => n.id === beforeId) : order.length;
  order.splice(at < 0 ? order.length : at, 0, moved);
  return order.map((n, i) => ({ id: n.id, sort_order: (i + 1) * 1000 })).filter((c) => pages.find((n) => n.id === c.id)?.sort_order !== c.sort_order);
}
