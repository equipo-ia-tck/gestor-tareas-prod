import { addDays, mondayOf } from './dates';
import type { Chunk, ChunkSource } from './knowledge';
import { docChunks, splitSections, type KnowledgeDoc } from './knowledge';
import { withDescendants } from './projects';
import { isActive, isOverdue, sortTasks } from './selectors';
import { fold } from './text';
import { parseDateText } from '../parser/fields';
import type { ISODate, Note, Person, Project, StateCategory, Task } from './types';
import type { ItemType } from './types';
import { stateOf } from './workflows';

/**
 * Asistente de Marea, sin IA: entiende frases con forma conocida (preguntas sobre tareas, notas y personas, y órdenes
 * como crear una tarea o completarla) y, si no, busca en todo (tareas, notas, personas, proyectos y documentación).
 */

export type When = 'today' | 'overdue' | 'myday' | 'nodate' | { from: ISODate; to: ISODate; label: string };

export interface TaskQuery {
  when?: When;
  person?: string;
  projectId?: string;
  category?: StateCategory;
  /** ID externo exacto (US1234, LS-12…). */
  externalId?: string;
}

export type Intent =
  | { kind: 'help' }
  | { kind: 'tasks'; query: TaskQuery; label: string }
  | { kind: 'done'; from: ISODate; to: ISODate; label: string }
  | { kind: 'said'; person: string }
  | { kind: 'topics'; person: string }
  | { kind: 'person'; person: string }
  | { kind: 'create-task'; text: string }
  | { kind: 'create-note'; title: string; body: string }
  | { kind: 'act'; action: 'complete' | 'reopen' | 'state' | 'date' | 'my-day'; query: string; category?: StateCategory; date?: ISODate | null; label: string }
  | { kind: 'search'; query: string; sources?: ChunkSource[] };

export interface IntentContext {
  today: ISODate;
  /** Personas conocidas (de tareas, notas, fichas y cuentas). */
  people: string[];
  projects: Project[];
}

const CATEGORY_WORDS: [RegExp, StateCategory, string][] = [
  [/\bbloquead[ao]s?\b/, 'blocked', 'bloqueadas'],
  [/\ben curso\b|\ben progreso\b|\bempezad[ao]s?\b/, 'doing', 'en curso'],
  [/\b(hech[ao]s?|completad[ao]s?|terminad[ao]s?|acabad[ao]s?)\b/, 'done', 'hechas'],
  [/\b(por hacer|sin empezar)\b/, 'todo', 'por hacer'],
];

/** El nombre conocido que aparece en el texto (completo o por su nombre de pila), el más largo. */
export function findPerson(text: string, people: string[]): string | undefined {
  const f = ` ${fold(text).replace(/[^\p{L}\p{N}@]+/gu, ' ')} `;
  const scored = people.map((p) => {
    const full = fold(p).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!full) return null;
    if (f.includes(` ${full} `) || f.includes(` @${full.replace(/ /g, '')} `)) return { p, s: full.length + 100 };
    const first = full.split(' ')[0];
    if (first.length >= 3 && (f.includes(` ${first} `) || f.includes(` @${first} `))) return { p, s: first.length };
    return null;
  }).filter((x): x is { p: string; s: number } => !!x);
  return scored.sort((a, b) => b.s - a.s)[0]?.p;
}

/** El proyecto que se nombra («#caixa», «proyecto Imagin», «en Fundación Cadete»), el de nombre más largo. */
export function findProject(text: string, projects: Project[]): Project | undefined {
  const f = ` ${fold(text).replace(/[^\p{L}\p{N}#/]+/gu, ' ')} `;
  const hashed = /#([\p{L}\p{N}/_-]+)/u.exec(fold(text))?.[1]?.replace(/[-_]/g, ' ');
  return projects
    .map((p) => ({ p, k: fold(p.name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }))
    .filter(({ k }) => k.length >= 3 && (f.includes(` ${k} `) || f.includes(` #${k.replace(/ /g, '')} `) || hashed === k || (hashed && k.startsWith(hashed))))
    .sort((a, b) => b.k.length - a.k.length)[0]?.p;
}

/** Periodo nombrado en la frase. */
function findWhen(f: string, today: ISODate): When | undefined {
  if (/\batrasad[ao]s?\b|\bvencid[ao]s?\b|\bse me han pasado\b/.test(f)) return 'overdue';
  if (/\bmi dia\b/.test(f)) return 'myday';
  if (/\bsin fecha\b/.test(f)) return 'nodate';
  if (/\bpasado manana\b/.test(f)) return { from: addDays(today, 2), to: addDays(today, 2), label: 'pasado mañana' };
  if (/\bmanana\b/.test(f)) return { from: addDays(today, 1), to: addDays(today, 1), label: 'mañana' };
  if (/\b(semana que viene|proxima semana)\b/.test(f)) { const m = addDays(mondayOf(today), 7); return { from: m, to: addDays(m, 6), label: 'la semana que viene' }; }
  if (/\b(esta semana)\b/.test(f)) return { from: today, to: addDays(mondayOf(today), 6), label: 'esta semana' };
  if (/\bproximos? (7|siete) dias\b|\bproximos dias\b/.test(f)) return { from: today, to: addDays(today, 6), label: 'los próximos 7 días' };
  if (/\bhoy\b|\bque tengo\b|\bque me toca\b/.test(f)) return 'today';
  return undefined;
}

const clean = (s: string) => s.replace(/^[\s:,-]+|[\s?¿!¡.,]+$/g, '').trim();

export function parseIntent(input: string, ctx: IntentContext): Intent {
  const text = input.replace(/\s+/g, ' ').trim();
  const f = fold(text).replace(/[¿?¡!]/g, '').trim();
  const rest = (re: RegExp) => { const m = re.exec(text); return m ? clean(text.slice(m.index + m[0].length)) : ''; };

  if (!f || /^(ayuda|help|que (puedes|sabes) hacer|como (funciona|te uso)|que te puedo (pedir|preguntar))\b/.test(f)) return { kind: 'help' };

  // ---- Órdenes ----
  if (/^(crea|crear|anade|anadir|apunta|nueva|nuevo|escribe)( una| un)? (nota|acta)\b/.test(f)) {
    const body = rest(/^\S+( una| un)? (nota|acta)\b(\s+(sobre|de|titulada|llamada))?/i);
    const colon = body.indexOf(':');
    return colon > 0
      ? { kind: 'create-note', title: clean(body.slice(0, colon)), body: body.slice(colon + 1).trim() }
      : { kind: 'create-note', title: body, body: '' };
  }
  if (/^(crea|crear|anade|anadir|apunta|nueva|nuevo|haz)( una| un)? (tarea|recordatorio|pendiente)\b/.test(f)) {
    return { kind: 'create-task', text: rest(/^\S+( una| un)? (tarea|recordatorio|pendiente)\b:?/i) };
  }
  if (/^recuerdame\b/.test(f)) {
    // «recuérdame a las 9 llamar a Ana» lo entiende la captura; «recuérdame llamar a Ana», sin hora, es una tarea.
    return { kind: 'create-task', text: /\ba las \d/.test(f) ? text : rest(/^recu[eé]rdame( que)?/i) };
  }
  if (/^(anade|anadir|apunta) /.test(f) && !/\b(a|en) mi dia$/.test(f)) return { kind: 'create-task', text: rest(/^\S+/) };

  const myDay = /^(anade|anadir|pon|mete|meter)\s+(.+?)\s+(a|en) mi dia$/.exec(f);
  if (myDay) return { kind: 'act', action: 'my-day', query: clean(text.split(/\s+(a|en) mi d[ií]a/i)[0].replace(/^\S+\s+/, '')), label: 'Añadir a Mi día' };
  if (/^(completa|completar|termina|terminar|cierra|cerrar|marca como (hecha|completada|terminada)|he (hecho|terminado|acabado))\b/.test(f)) {
    return { kind: 'act', action: 'complete', query: rest(/^(completa|completar|termina|terminar|cierra|cerrar|marca como (hecha|completada|terminada)|he (hecho|terminado|acabado))\b/i), label: 'Completar' };
  }
  if (/^(reabre|reabrir|vuelve a abrir|desmarca)\b/.test(f)) return { kind: 'act', action: 'reopen', query: rest(/^(reabre|reabrir|vuelve a abrir|desmarca)\b/i), label: 'Reabrir' };
  const toState = /^(pon|pasa|mueve|cambia|marca)\s+(.+?)\s+(?:(?:a|como|en)\s+)?(en curso|en progreso|bloquead[ao]s?|hech[ao]s?|completad[ao]s?|terminad[ao]s?|por hacer|pendientes?)$/i.exec(text);
  if (toState) {
    const target = fold(toState[3]);
    const cat = CATEGORY_WORDS.find(([re]) => re.test(target)) ?? CATEGORY_WORDS[3];
    return { kind: 'act', action: 'state', query: clean(toState[2]), category: cat[1], label: `Pasar a ${cat[2].replace(/s$/, '')}` };
  }
  const move = /^(pon|pasa|mueve|cambia|marca)\s+(.+?)\s+(a|en|como|para)\s+(.+)$/i.exec(text);
  if (move) {
    const target = fold(move[4]).trim();
    const cat = CATEGORY_WORDS.find(([re]) => re.test(target)) ?? (/^(pendiente|todo)$/.test(target) ? CATEGORY_WORDS[3] : undefined);
    if (cat) return { kind: 'act', action: 'state', query: clean(move[2]), category: cat[1], label: `Pasar a ${cat[2].replace(/s$/, '')}` };
    const date = parseDateText(move[4].replace(/^(el|la)\s+/i, ''), ctx.today);
    if (date.ok) return { kind: 'act', action: 'date', query: clean(move[2]), date: date.value, label: date.value ? 'Cambiar la fecha' : 'Quitar la fecha' };
  }
  if (/^(pospon|posponer|aplaza|aplazar|retrasa)\b/.test(f)) {
    const m = /^\S+\s+(.+?)(?:\s+(?:a|para|hasta)\s+(.+))?$/i.exec(text);
    if (m) {
      const date = m[2] ? parseDateText(m[2], ctx.today) : { ok: true as const, value: addDays(ctx.today, 1) };
      if (date.ok) return { kind: 'act', action: 'date', query: clean(m[1]), date: date.value, label: 'Posponer' };
    }
  }

  // ---- Preguntas sobre personas y notas ----
  const person = findPerson(text, ctx.people);
  if (/\b(temas|para hablar|que tengo que hablar|pendiente de hablar|hablar con)\b/.test(f) && person) return { kind: 'topics', person };
  if (/\b(que (dijo|ha dicho|comento|ha comentado|se dijo|se hablo|hablamos)|lo que (dijo|se hablo)|reuniones? con|actas? con)\b/.test(f) && person) return { kind: 'said', person };
  if (/^(quien es|email de|correo de|rol de|ficha de|datos de|contacto de)\b/.test(f) && person) return { kind: 'person', person };

  // ---- Lo hecho ----
  if (/\b(que (he|hemos|ha) (hecho|completado|terminado)|que hice|lo (que he )?hecho|lo completado)\b/.test(f)) {
    if (/\bhoy\b/.test(f)) return { kind: 'done', from: ctx.today, to: ctx.today, label: 'hoy' };
    if (/\bayer\b/.test(f)) return { kind: 'done', from: addDays(ctx.today, -1), to: addDays(ctx.today, -1), label: 'ayer' };
    if (/\bsemana pasada\b/.test(f)) { const m = addDays(mondayOf(ctx.today), -7); return { kind: 'done', from: m, to: addDays(m, 6), label: 'la semana pasada' }; }
    if (/\beste mes\b/.test(f)) return { kind: 'done', from: `${ctx.today.slice(0, 8)}01`, to: ctx.today, label: 'este mes' };
    return { kind: 'done', from: mondayOf(ctx.today), to: ctx.today, label: 'esta semana' };
  }

  // ---- Tareas con filtros ----
  const externalId = /\b([A-Z]{1,3}-?\d{2,})\b/.exec(text)?.[1];
  if (externalId && text.replace(externalId, '').replace(/\b(estado|de|del|la|el|que|pasa|con|como|va|esta)\b/gi, '').replace(/[\s?¿]/g, '').length < 3) {
    return { kind: 'tasks', query: { externalId }, label: externalId };
  }
  const when = findWhen(f, ctx.today);
  const category = CATEGORY_WORDS.find(([re]) => re.test(f))?.[1];
  const project = findProject(text, ctx.projects);
  const asksTasks = /\b(tareas?|pendientes?|que tengo|que me toca|que hay|que queda|elementos|cosas)\b/.test(f);
  if (when || (asksTasks && (person || project || category)) || ((person || project) && category)) {
    const parts = [
      category ? CATEGORY_WORDS.find(([, c]) => c === category)![2] : 'pendientes',
      person ? `de ${person}` : '',
      project ? `en ${project.name}` : '',
      when ? (typeof when === 'string' ? { today: 'para hoy', overdue: 'atrasadas', myday: 'en Mi día', nodate: 'sin fecha' }[when] : when.label) : '',
    ].filter(Boolean);
    return { kind: 'tasks', query: { when, person, projectId: project?.id, category }, label: `Tareas ${parts.join(' ')}` };
  }
  if (asksTasks && !/\b(sobre|de que|como|donde|cuando|por que|que es)\b/.test(f)) return { kind: 'tasks', query: { when: 'today' }, label: 'Tareas para hoy' };

  // ---- Buscar en todo ----
  const sources: ChunkSource[] | undefined = /\b(documento|documentacion|guia|manual|proceso|procedimiento|politica|como se)\b/.test(f) ? ['doc', 'note'] : undefined;
  return { kind: 'search', query: text, sources };
}

/** Tareas que responden a una consulta (las completadas solo si se piden «hechas»). */
export function queryTasks(tasks: Task[], q: TaskQuery, ctx: { today: ISODate; projects: Project[]; types: ItemType[] }): Task[] {
  const scope = q.projectId ? withDescendants(q.projectId, ctx.projects) : null;
  return sortTasks(tasks.filter((t) => {
    if (t.deleted_at || t.status === 'archived') return false;
    if (q.externalId) return fold(t.external_id ?? '').replace('-', '') === fold(q.externalId).replace('-', '');
    if (q.category === 'done' ? t.status !== 'done' : !isActive(t)) return false;
    if (q.category && q.category !== 'done' && stateOf(ctx.types, t).category !== q.category) return false;
    if (q.person && !t.people.some((p) => fold(p) === fold(q.person!) || fold(p).split(' ')[0] === fold(q.person!).split(' ')[0] && fold(q.person!).split(' ').length === 1)) return false;
    if (scope && !(t.project_id && scope.has(t.project_id))) return false;
    const w = q.when;
    if (w === 'today') return !!t.due_date && t.due_date <= ctx.today || t.my_day === ctx.today;
    if (w === 'overdue') return isOverdue(t, ctx.today);
    if (w === 'myday') return t.my_day === ctx.today;
    if (w === 'nodate') return !t.due_date;
    if (w) return !!t.due_date && t.due_date >= w.from && t.due_date <= w.to;
    return true;
  }));
}

/** Tareas cuyo título se parece a lo escrito (para «completa revisar login»): la exacta primero. */
export function matchTasks(tasks: Task[], query: string, onlyActive = true): Task[] {
  const q = fold(query).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!q) return [];
  const words = q.split(' ').filter((w) => w.length > 1);
  return tasks
    .filter((t) => !t.deleted_at && t.status !== 'archived' && (!onlyActive || t.status === 'todo'))
    .map((t) => {
      const title = fold(`${t.title} ${t.external_id ?? ''}`).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const score = title === q ? 100 : title.includes(q) ? 50 : words.filter((w) => title.includes(w)).length / words.length * 40;
      return { t, score };
    })
    .filter((x) => x.score >= 30)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}

/** Los trozos buscables de todo lo que ve la persona: tareas, notas, personas, proyectos y documentación. */
export function buildChunks(data: {
  tasks: Task[]; notes: Note[]; people: Person[]; projects: Project[]; docs: Pick<KnowledgeDoc, 'id' | 'title' | 'body'>[];
  /** Elementos de la Microsoft List (pantalla Lista), con sus columnas. */
  listItems?: { id: string; title: string; fields: Record<string, string> }[];
}): Chunk[] {
  const out: Chunk[] = [];
  for (const t of data.tasks) {
    if (t.deleted_at) continue;
    out.push({ id: `task:${t.id}`, source: 'task', ref: t.id, title: t.title,
      text: [t.external_id, t.notes, t.people.map((p) => `@${p}`).join(' '), t.tags.map((x) => `+${x}`).join(' ')].filter(Boolean).join('\n') });
  }
  for (const n of data.notes) {
    if (n.deleted_at) continue;
    const parts = splitSections(n.body.replace(/\[\[t:[^\]]+\]\]/g, ''));
    if (!parts.length) out.push({ id: `note:${n.id}:0`, source: 'note', ref: n.id, title: n.title, text: '' });
    parts.forEach((s, i) => out.push({ id: `note:${n.id}:${i}`, source: 'note', ref: n.id, title: n.title, section: s.section || undefined, text: s.text }));
  }
  for (const p of data.people) {
    out.push({ id: `person:${p.name}`, source: 'person', ref: p.name, title: p.name, text: [p.role, p.email, p.notes].filter(Boolean).join('\n') });
  }
  for (const p of data.projects) out.push({ id: `project:${p.id}`, source: 'project', ref: p.id, title: p.name, text: '' });
  for (const d of data.docs) out.push(...docChunks(d));
  for (const it of data.listItems ?? []) {
    out.push({ id: `list:${it.id}`, source: 'list', ref: it.id, title: it.title, text: Object.entries(it.fields).map(([k, v]) => `${k}: ${v}`).join('\n') });
  }
  return out;
}

/** Ejemplos que enseña el Asistente (y la ayuda). */
export const ASSISTANT_EXAMPLES: { group: string; items: string[] }[] = [
  { group: 'Tareas', items: ['¿Qué tengo hoy?', 'Tareas atrasadas', 'Tareas de Ana esta semana', 'Bloqueadas en #caixa', '¿Qué he hecho esta semana?', 'US1234'] },
  { group: 'Personas y notas', items: ['¿Qué dijo Diana?', 'Temas para hablar con Luis', '¿Quién es Ana?'] },
  { group: 'Hacer cosas', items: ['Crea una tarea revisar login para el viernes #caixa !1', 'Completa revisar login', 'Pon revisar login en curso', 'Mueve revisar login a mañana', 'Añade revisar login a mi día', 'Crea una nota Reunión con Ana: hablar del sprint'] },
  { group: 'Documentación y Lista', items: ['¿Cómo se entrega una guía?', 'Proceso de etiquetado', 'Medición Imagin en curso'] },
];
