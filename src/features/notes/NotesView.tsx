import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { DateButton } from '../../components/ui/DatePicker';
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

// El editor con formato pesa: se carga al abrir una nota, no al arrancar la app.
const NoteEditor = lazy(() => import('./NoteEditor').then((m) => ({ default: m.NoteEditor })));
import { AtSign, FileText, ListChecks, MessageSquare, Pin, Plus, Search, Trash2, Users } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { navigate } from '../../app/router';
import { AvatarStack, StatePill } from '../../components/ui/Badges';
import { repo } from '../../data/services';
import { formatDay } from '../../domain/dates';
import { actionItems } from '../../domain/markdown';
import { defaultNoteTitle, matchesNote, meetingTemplate, noteExcerpt, noteLines, reorderPages, sortNotes, sortPages } from '../../domain/notes';
import { ancestry, flattenTree, MAX_PROJECT_DEPTH, projectPath, projectTree } from '../../domain/projects';
import { usePersistentState } from '../../hooks/usePersistentState';
import { fold, nameKey } from '../../domain/text';
import { TOPIC_TYPE_ID, type Note, type NoteKind, type Project } from '../../domain/types';
import { stateOf } from '../../domain/workflows';
import { createTasksFromActions } from './noteActions';
import { IcsImport } from './IcsImport';
import { MeetingLink, ShareMeeting } from './MeetingTools';
import { NoteLineList } from './LineToTask';
import { taskLabel } from './TaskNotes';
import { TypeBadge } from '../../components/ui/Badges';
import { findType } from '../../domain/workflows';

/** Crea una nota o un acta (con plantilla) y la abre. */
export async function newNote(kind: NoteKind, today: string, fields: Partial<Note> = {}) {
  const n = await repo.createNote({
    date: today, kind, title: defaultNoteTitle(kind, today),
    body: kind === 'meeting' ? meetingTemplate(fields.people ?? []) : '',
    ...fields,
  });
  navigate({ view: 'notes', id: n.id });
  return n;
}

const ALL = '~all';
const NONE = '~none';

/**
 * Notas al estilo OneNote: secciones (proyectos y subproyectos, con su color) a la izquierda,
 * páginas de la sección en medio (en orden manual, arrastrando) y la página abierta a la derecha.
 */
export function NotesView({ id }: { id?: string }) {
  useWideLayout(true);
  const { notes, tasks, projects, projectMap, today } = useApp();
  const [stored, setSection] = usePersistentState('notes-section', ALL);
  const [query, setQuery] = useState('');
  const current = id ? notes.find((n) => n.id === id) : undefined;

  // Las notas de un elemento pertenecen al proyecto de ese elemento (aunque se mueva).
  const sectionOf = (n: Note) => (n.task_id ? tasks.find((t) => t.id === n.task_id)?.project_id ?? n.project_id : n.project_id) ?? NONE;
  // Al abrir una nota concreta (también desde fuera de Notas), su sección queda seleccionada.
  const currentSection = current ? sectionOf(current) : null;
  const [synced, setSynced] = useState(currentSection);
  if (currentSection !== synced) {
    setSynced(currentSection);
    if (currentSection) setSection(currentSection);
  }
  const section = stored;

  const words = fold(query).split(/\s+/).filter(Boolean);
  const inSection = notes.filter((n) => (section === ALL || sectionOf(n) === section) && (!words.length || matchesNote(n, words)));
  const pages = section === ALL ? sortNotes(inSection.filter((n) => !n.task_id)) : sortPages(inSection.filter((n) => !n.task_id));
  const itemNotes = sortNotes(inSection.filter((n) => n.task_id));
  const sectionProject = section !== ALL && section !== NONE ? projectMap.get(section) : undefined;
  const count = (key: string) => notes.filter((n) => sectionOf(n) === key).length;

  /** Como en OneNote: al elegir otra sección se abre su primera página. */
  const selectSection = (key: string) => {
    setSection(key);
    if (current && (key === ALL || sectionOf(current) === key)) return;
    const inKey = notes.filter((n) => !n.task_id && (key === ALL || sectionOf(n) === key));
    const first = (key === ALL ? sortNotes(inKey) : sortPages(inKey))[0];
    navigate(first ? { view: 'notes', id: first.id } : { view: 'notes' });
  };

  const addPage = (kind: NoteKind) => void newNote(kind, today, { project_id: sectionProject?.id ?? null });

  return (
    <div className="grid h-[calc(100dvh-7rem)] min-h-[480px] grid-cols-[210px_250px_1fr] overflow-hidden rounded-xl border border-zinc-200 bg-white max-lg:h-auto max-lg:grid-cols-1 dark:border-zinc-800 dark:bg-zinc-950">
      {/* Secciones */}
      <nav aria-label="Secciones" className="flex min-h-0 flex-col border-r border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40">
        <h2 className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Secciones</h2>
        <AddSection parent={sectionProject} onCreated={(pid) => selectSection(pid)} />
        <div className="flex-1 overflow-y-auto pb-2">
          <SectionRow label="Todas las notas" color="#a1a1aa" active={section === ALL} count={notes.length} onClick={() => selectSection(ALL)} />
          {flattenTree(projectTree(projects)).map(({ project: p, depth }) => (
            <SectionRow key={p.id} label={p.name} color={p.color} depth={depth} active={section === p.id} count={count(p.id)} onClick={() => selectSection(p.id)} />
          ))}
          {count(NONE) > 0 && <SectionRow label="Sin sección" color="#d4d4d8" active={section === NONE} count={count(NONE)} onClick={() => selectSection(NONE)} />}
        </div>
      </nav>

      {/* Páginas */}
      <div className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="space-y-2 px-3 pt-3 pb-2">
          <div className="flex items-center gap-1">
            <h2 className="flex-1 truncate text-sm font-semibold" title={sectionProject ? projectPath(sectionProject.id, projectMap) : undefined}>
              {section === ALL ? 'Todas las notas' : section === NONE ? 'Sin sección' : sectionProject?.name}
            </h2>
            <IcsImport />
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={() => addPage('note')} className="flex flex-1 items-center justify-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-900 dark:bg-zinc-900 dark:text-indigo-400 dark:hover:bg-indigo-950">
              <Plus className="size-4" />Agregar página
            </button>
            <button type="button" onClick={() => addPage('meeting')} title="Nueva acta de reunión" className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800">
              <Users className="size-4" />Acta
            </button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar páginas…"
              className="w-full rounded-md border border-zinc-200 bg-white py-1 pr-2 pl-7 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <PageList pages={pages} activeId={id} reorderable={section !== ALL && !words.length} />
          {itemNotes.length > 0 && (
            <>
              <h3 className="mt-3 px-3 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Notas de US, TS y tareas · {itemNotes.length}</h3>
              <PageList pages={itemNotes} activeId={id} reorderable={false} />
            </>
          )}
          {!pages.length && !itemNotes.length && (
            <p className="px-3 py-4 text-sm text-zinc-400">{words.length ? 'Nada coincide.' : 'Sección vacía. Añade una página o un acta.'}</p>
          )}
        </div>
      </div>

      {/* Contenido */}
      <section className="min-w-0 overflow-y-auto px-8 py-5">
        {current ? <NotePage key={current.id} note={current} /> : (
          <div className="flex h-64 flex-col items-center justify-center text-sm text-zinc-400">
            <FileText className="mb-2 size-6" />Elige una página o crea una nueva
          </div>
        )}
      </section>
    </div>
  );
}

/** Sección con su color (barra a la izquierda, como las pestañas de OneNote). */
function SectionRow({ label, color, active, count, depth = 0, onClick }: {
  label: string; color: string; active: boolean; count: number; depth?: number; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
      className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm ${active ? 'bg-white font-medium shadow-sm dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
      <span className="h-5 w-1 shrink-0 rounded-full" style={{ background: color }} />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && <span className="text-xs text-zinc-400">{count}</span>}
    </button>
  );
}

function AddSection({ parent, onCreated }: { parent?: Project; onCreated: (id: string) => void }) {
  const { projectMap } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const canNest = !!parent && ancestry(parent.id, projectMap).length < MAX_PROJECT_DEPTH;
  const [inside, setInside] = useState(false);
  async function create(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) {
      const p = await repo.createProject(name.trim(), { parent_id: inside && canNest ? parent!.id : null });
      onCreated(p.id);
    }
    setName('');
    setOpen(false);
  }
  if (!open) {
    return (
      <div className="px-2 pb-2">
        <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-900 dark:bg-zinc-900 dark:text-indigo-400 dark:hover:bg-indigo-950">
          <Plus className="size-4" />Agregar sección
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={create} className="space-y-1 px-2 pb-2">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre de la sección"
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
      {canNest && (
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          <input type="checkbox" checked={inside} onChange={(e) => setInside(e.target.checked)} />Dentro de {parent!.name}
        </label>
      )}
    </form>
  );
}

/** Lista de páginas; si es reordenable, se arrastran para cambiar su orden. */
function PageList({ pages, activeId, reorderable }: { pages: Note[]; activeId?: string; reorderable: boolean }) {
  const { tasks, itemTypes, today } = useApp();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  async function drop(beforeId: string | null) {
    if (!dragging) return;
    const changes = reorderPages(pages, dragging, beforeId);
    setDragging(null);
    setOver(null);
    if (changes.length) {
      await repo.batch('Páginas reordenadas', async () => {
        for (const c of changes) await repo.updateNote(c.id, { sort_order: c.sort_order });
      });
    }
  }

  return (
    <ul onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); void drop(null); }}>
      {pages.map((n) => {
        const task = n.task_id ? tasks.find((t) => t.id === n.task_id) : undefined;
        const active = n.id === activeId;
        return (
          <li key={n.id}
            draggable={reorderable}
            onDragStart={() => setDragging(n.id)}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(e) => { if (dragging && dragging !== n.id) { e.preventDefault(); e.stopPropagation(); setOver(n.id); } }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void drop(n.id); }}
            className={`${over === n.id ? 'border-t-2 border-indigo-500' : 'border-t-2 border-transparent'} ${dragging === n.id ? 'opacity-40' : ''}`}>
            <a href={`#/notes/${n.id}`}
              className={`block px-3 py-1.5 ${active ? 'bg-indigo-50 font-medium text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
              <span className="flex items-center gap-1.5 text-sm">
                {task ? <TypeBadge type={findType(itemTypes, task.type_id)} /> : n.kind === 'meeting' && <Users className="size-3.5 shrink-0 text-zinc-400" />}
                <span className="truncate">{task ? taskLabel(task) : n.title || 'Sin título'}</span>
                {n.pinned && <Pin className="size-3 shrink-0 text-amber-500" />}
              </span>
              <span className="block truncate text-[11px] text-zinc-400">{formatDay(n.date, today)}{noteExcerpt(n) ? ` · ${noteExcerpt(n)}` : ''}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function NotePage({ note }: { note: Note }) {
  const { tasks, projects, allProjects, today, itemTypes, releases, mentionables } = useApp();
  const [title, setTitle] = useState(note.title);
  useEffect(() => setTitle(note.title), [note.title]);
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const ctx = { today, projects, people: mentionables, types: itemTypes, releases };
  const actions = actionItems(note.body);
  const unlinked = actions.filter((a) => !a.taskId);
  // Líneas con @persona o #proyecto que no son acciones (las acciones ya tienen su panel).
  const actionLines = new Set(actions.map((a) => a.line));
  const mentions = noteLines([note], allProjects).filter((l) => !actionLines.has(l.line));
  const showSide = note.kind === 'meeting' || actions.length > 0 || mentions.length > 0;

  return (
    <article className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {(['meeting', 'note'] as NoteKind[]).map((k) => (
            <button key={k} type="button" onClick={() => void repo.updateNote(note.id, { kind: k })}
              className={`rounded px-2 py-0.5 text-xs ${note.kind === k ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500'}`}>{k === 'meeting' ? 'Acta' : 'Nota'}</button>
          ))}
        </div>
        <DateButton value={note.date} clearable={false} onChange={(d) => d && void repo.updateNote(note.id, { date: d })}
          className="rounded-md border border-transparent px-1.5 py-0.5 text-zinc-600 hover:border-zinc-200 dark:text-zinc-300 dark:hover:border-zinc-700" />
        <select value={note.project_id ?? ''} onChange={(e) => void repo.updateNote(note.id, { project_id: e.target.value || null })}
          className="rounded-md border border-transparent bg-transparent px-1 text-zinc-600 hover:border-zinc-200 dark:text-zinc-300 dark:hover:border-zinc-700" aria-label="Proyecto">
          <option value="">Sin proyecto</option>
          <ProjectOptions />
        </select>
        {note.people.length > 0 && <span className="flex items-center gap-1.5 text-xs text-zinc-500"><AvatarStack names={note.people} max={6} size={20} /></span>}
        <span className="flex-1" />
        {note.kind === 'meeting' && <ShareMeeting note={note} />}
        <button type="button" title={note.pinned ? 'Desfijar' : 'Fijar arriba'} onClick={() => void repo.updateNote(note.id, { pinned: !note.pinned })}
          className={`rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${note.pinned ? 'text-amber-500' : 'text-zinc-400'}`}><Pin className="size-4" /></button>
        <button type="button" title="Eliminar" onClick={() => { void repo.deleteNote(note.id); navigate({ view: 'notes' }); }}
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"><Trash2 className="size-4" /></button>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título"
        onBlur={() => { if (title.trim() !== note.title) void repo.updateNote(note.id, { title: title.trim() }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="mb-3 w-full bg-transparent text-2xl font-bold outline-none placeholder:text-zinc-300" />
      {note.task_id && <TaskOrigin taskId={note.task_id} />}
      {note.kind === 'meeting' && <MeetingLink note={note} />}

      {/* El lateral (acciones, menciones, temas de los asistentes) solo en actas o si la nota tiene acciones o menciones. */}
      <div className={`grid gap-6 ${showSide ? '2xl:grid-cols-[1fr_260px]' : ''}`}>
        <Suspense fallback={<p className="text-sm text-zinc-400">Abriendo el editor…</p>}><NoteEditor note={note} /></Suspense>
        {showSide && <div className="space-y-5 text-sm">
          <SidePanel icon={<ListChecks className="size-4" />} title={`Acciones · ${actions.filter((a) => (a.taskId ? taskMap.get(a.taskId)?.status === 'done' : a.checked)).length}/${actions.length}`}>
            {actions.length === 0 && <p className="text-xs text-zinc-400">Escribe acciones con <code>- [ ] …</code> (admiten @persona, fechas y !1).</p>}
            {unlinked.length > 0 && (
              <button type="button" onClick={() => void createTasksFromActions(note, ctx)}
                className="mb-2 w-full rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500">
                Convertir {unlinked.length} en tarea{unlinked.length === 1 ? '' : 's'}
              </button>
            )}
            <LinkedTasks ids={actions.flatMap((a) => (a.taskId ? [a.taskId] : []))} />
          </SidePanel>
          {mentions.length > 0 && (
            <SidePanel icon={<AtSign className="size-4" />} title={`Menciones · ${mentions.length}`}>
              <NoteLineList lines={mentions} showSource={false} />
            </SidePanel>
          )}
          <AttendeeTopics people={note.people} />
        </div>}
      </div>
    </article>
  );
}

/** En una nota de un elemento: de qué US/TS es (abre su panel). */
function TaskOrigin({ taskId }: { taskId: string }) {
  const { tasks, itemTypes, editTask } = useApp();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return <p className="mb-3 text-xs text-zinc-400">Nota de un elemento eliminado.</p>;
  const type = findType(itemTypes, task.type_id);
  return (
    <button type="button" onClick={() => editTask(task)}
      className="mb-3 flex items-center gap-2 rounded-md bg-zinc-100 px-2 py-1 text-sm hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700">
      <span className="text-xs text-zinc-500">Nota de</span><TypeBadge type={type} /><span className="font-medium">{taskLabel(task)}</span>
      <StatePill state={stateOf(itemTypes, task)} />
    </button>
  );
}

function SidePanel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{icon}{title}</h3>
      {children}
    </section>
  );
}

function LinkedTasks({ ids }: { ids: string[] }) {
  const { tasks, itemTypes, editTask } = useApp();
  const linked = ids.map((i) => tasks.find((t) => t.id === i)).filter((t) => !!t);
  if (!linked.length) return null;
  return (
    <ul className="space-y-1">
      {linked.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => editTask(t)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <span className={`flex-1 truncate ${t.status === 'done' ? 'text-zinc-400 line-through' : ''}`}>{t.title}</span>
            <StatePill state={stateOf(itemTypes, t)} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** En una reunión: los temas pendientes que tenías con cada asistente. */
function AttendeeTopics({ people }: { people: string[] }) {
  const { tasks } = useApp();
  const topics = tasks.filter((t) => t.type_id === TOPIC_TYPE_ID && t.status === 'todo' && t.people.some((p) => people.some((a) => nameKey(a) === nameKey(p))));
  if (!people.length) return null;
  return (
    <SidePanel icon={<MessageSquare className="size-4" />} title="Para hablar con los asistentes">
      {!topics.length && <p className="text-xs text-zinc-400">Ninguno. Añádelos desde la ficha de cada persona.</p>}
      <ul className="space-y-1">
        {topics.map((t) => (
          <li key={t.id} className="flex items-start gap-2 text-xs">
            <button type="button" title="Marcar como hablado" onClick={() => void repo.setCompleted(t.id, true)}
              className="mt-0.5 size-3.5 shrink-0 rounded-full border border-amber-500 hover:bg-amber-100 dark:hover:bg-amber-950" />
            <span className="flex-1">{t.title} <span className="text-zinc-400">· {t.people.join(', ')}</span></span>
          </li>
        ))}
      </ul>
    </SidePanel>
  );
}
