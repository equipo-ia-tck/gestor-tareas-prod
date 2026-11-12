import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderOpen, Search, Users } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { routeHref } from '../../app/router';
import { Section, TaskList } from '../../components/TaskList';
import { Avatar } from '../../components/ui/Badges';
import { formatDay } from '../../domain/dates';
import { matchesNote, noteExcerpt, sortNotes } from '../../domain/notes';
import { peopleDirectory } from '../../domain/people';
import { useRallyOwners } from '../rally/rallyStore';
import { projectPath } from '../../domain/projects';
import { isEmptySearch, matchesSearch, parseSearch } from '../../domain/search';
import { sortTasks } from '../../domain/selectors';
import { fold } from '../../domain/text';
import { ViewHeader } from './ViewHeader';

/** Buscador único: tareas, notas, personas y proyectos a la vez. */
export function SearchView({ q }: { q: string }) {
  const { tasks, notes, peopleCards, allProjects, projectMap, today, editTask } = useApp();
  const query = useMemo(() => parseSearch(q), [q]);
  const words = query.words;
  const results = useMemo(
    () => (isEmptySearch(query) ? [] : sortTasks(tasks.filter((t) => matchesSearch(t, query, projectMap)))),
    [tasks, query, projectMap],
  );
  // Notas, personas y proyectos se buscan por palabras (los filtros #, @ y + son de tareas).
  const hit = (text: string) => words.length > 0 && words.every((w) => fold(text).includes(w));
  const noteHits = words.length ? sortNotes(notes.filter((n) => matchesNote(n, words))) : [];
  const rallyOwners = useRallyOwners(tasks);
  const peopleHits = peopleDirectory(tasks, notes, peopleCards, rallyOwners).filter((p) => hit(p.name));
  const projectHits = allProjects.filter((p) => hit(p.name));
  const total = results.length + noteHits.length + peopleHits.length + projectHits.length;

  return (
    <>
      <ViewHeader
        title="Buscar"
        subtitle={isEmptySearch(query) ? 'Escribe lo que buscas (desde cualquier pantalla, pulsa /)' : `${total} resultado${total === 1 ? '' : 's'} para «${q}»`}
      />
      <SearchBox q={q} />
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        Busca en tareas, notas, personas y proyectos. Para tareas puedes filtrar con <code>#proyecto</code>, <code>@persona</code> o <code>+etiqueta</code>; añade <code>todas:</code> para incluir completadas.
      </p>

      {(peopleHits.length > 0 || projectHits.length > 0) && (
        <div className="mb-5 flex flex-wrap gap-2">
          {peopleHits.map((p) => (
            <a key={p.name} href={routeHref({ view: 'person', name: p.name })} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:border-indigo-300 dark:border-zinc-800">
              <Avatar name={p.name} size={20} />{p.name}<Users className="size-3 text-zinc-400" />
            </a>
          ))}
          {projectHits.map((p) => (
            <a key={p.id} href={routeHref({ view: 'project', id: p.id })} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:border-indigo-300 dark:border-zinc-800">
              <span className="size-2.5 rounded-sm" style={{ background: p.color }} />{projectPath(p.id, projectMap)}<FolderOpen className="size-3 text-zinc-400" />
            </a>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <Section title={`Tareas · ${results.length}`}>
          <TaskList tasks={results} today={today} projects={projectMap} onEdit={editTask} />
        </Section>
      )}
      {noteHits.length > 0 && (
        <Section title={`Notas · ${noteHits.length}`}>
          <ul>
            {noteHits.map((n) => (
              <li key={n.id}><a href={`#/notes/${n.id}`} className="flex justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <span className="flex min-w-0 items-center gap-1.5 truncate"><FileText className="size-3.5 shrink-0 text-zinc-400" />{n.title || 'Sin título'} <span className="truncate text-xs text-zinc-400">{noteExcerpt(n)}</span></span>
                <span className="shrink-0 text-xs text-zinc-400">{formatDay(n.date, today)}</span>
              </a></li>
            ))}
          </ul>
        </Section>
      )}
      {!isEmptySearch(query) && total === 0 && <p className="text-sm text-zinc-400">Nada coincide.</p>}
    </>
  );
}

/** Cuadro de búsqueda (antes estaba en la barra lateral). La consulta va en la dirección, así se puede volver atrás. */
function SearchBox({ q }: { q: string }) {
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);
  const change = (next: string) => {
    setValue(next);
    window.location.replace(routeHref({ view: 'search', q: next }));
  };
  return (
    <div className="relative mb-3 max-w-xl">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
      <input id="global-search" type="search" autoFocus value={value} onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
        placeholder="Buscar tareas, notas, personas y proyectos…" aria-label="Buscar"
        className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pr-2 pl-8 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
    </div>
  );
}
