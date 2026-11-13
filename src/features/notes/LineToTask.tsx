import { useApp } from '../../app/AppContext';
import { routeHref } from '../../app/router';
import { StatePill } from '../../components/ui/Badges';
import { formatDay } from '../../domain/dates';
import type { NoteLine } from '../../domain/notes';
import { TOPIC_TYPE_ID, type NewTask } from '../../domain/types';
import { stateOf } from '../../domain/workflows';
import { createTaskFromLine } from './noteActions';

/**
 * Botones «→ Tarea» y «→ Para hablar» de una línea de nota con @persona o #proyecto. Si la línea ya es una tarea
 * ([[t:id]]), muestra la tarea y su estado. `defaults` fija lo que manda el sitio desde donde se crea (la persona de la
 * ficha, el proyecto de la pantalla…); lo escrito en la línea (#proyecto, @persona, fecha) se suma o manda.
 */
export function LineToTask({ line, defaults = {}, topicPerson }: { line: NoteLine; defaults?: Partial<NewTask>; topicPerson?: string }) {
  const { tasks, today, projects, mentionables, itemTypes, releases, editTask } = useApp();
  const linked = line.taskId ? tasks.find((t) => t.id === line.taskId) : undefined;
  if (linked) {
    return (
      <button type="button" onClick={() => editTask(linked)} title="Abrir la tarea"
        className="mr-2 inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:underline dark:text-emerald-400">
        ✓ {linked.type_id === TOPIC_TYPE_ID ? 'En Para hablar' : 'Tarea'} <StatePill state={stateOf(itemTypes, linked)} />
      </button>
    );
  }
  const ctx = { today, projects, people: mentionables, types: itemTypes, releases };
  const topicFor = topicPerson ?? line.people[0];
  const create = (topic: boolean) => createTaskFromLine(line.note, line.line, ctx,
    topic ? { ...defaults, type_id: TOPIC_TYPE_ID, project_id: null, people: [topicFor] } : defaults,
    topic ? 'Añadido a Para hablar' : 'Tarea creada desde la nota');
  return (
    <span className="mr-2 inline-flex gap-1 opacity-60 group-hover:opacity-100">
      <button type="button" onClick={() => void create(false)} title="Crea la tarea con la persona, el proyecto y la fecha de la línea"
        className="rounded bg-indigo-50 px-1.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300">→ Tarea</button>
      {topicFor && (
        <button type="button" onClick={() => void create(true)} title={`Tema pendiente con ${topicFor}`}
          className="rounded bg-amber-50 px-1.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">→ Para hablar</button>
      )}
    </span>
  );
}

/** Lista de líneas de notas con su texto, sus botones y de qué nota salen. */
export function NoteLineList({ lines, defaults, topicPerson, showSource = true, max = 30 }: {
  lines: NoteLine[]; defaults?: Partial<NewTask>; topicPerson?: string; showSource?: boolean; max?: number;
}) {
  const { today } = useApp();
  return (
    <ul className="space-y-2">
      {lines.slice(0, max).map((m) => (
        <li key={`${m.note.id}-${m.line}`} className="group text-sm">
          <p className="leading-snug">{m.text}</p>
          <LineToTask line={m} defaults={defaults} topicPerson={topicPerson} />
          {showSource
            ? <a href={routeHref({ view: 'notes', id: m.note.id })} className="text-[11px] text-zinc-400 hover:underline">
                {formatDay(m.note.date, today)} · {m.note.title || 'nota'}{m.section ? ` · ${m.section}` : ''}
              </a>
            : m.section && <span className="text-[11px] text-zinc-400">{m.section}</span>}
        </li>
      ))}
    </ul>
  );
}
