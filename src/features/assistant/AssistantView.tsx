import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, CornerDownLeft, ExternalLink, FileText, FolderOpen, Lock, MessagesSquare, Trash2, Upload, User, Users, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { routeHref } from '../../app/router';
import { Modal } from '../../components/Modal';
import { TaskList } from '../../components/TaskList';
import { useToast } from '../../components/Toast';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import { useSync } from '../../data/sync';
import { ASSISTANT_EXAMPLES, buildChunks, matchTasks, parseIntent, queryTasks, type Intent } from '../../domain/assistant';
import { formatDay } from '../../domain/dates';
import { SearchIndex, type Hit, type KnowledgeDoc } from '../../domain/knowledge';
import { mentionsOf, type Mention } from '../../domain/notes';
import { peopleDirectory } from '../../domain/people';
import { TOPIC_TYPE_ID, type ActivityEntry, type Task } from '../../domain/types';
import { findType, stateForCategory } from '../../domain/workflows';
import { useTaskActions } from '../../hooks/useTaskActions';
import { parseCapture } from '../../parser/parseCapture';
import { submitCapture } from '../capture/submitCapture';
import { track } from '../usage/track';
import { ViewHeader } from '../views/ViewHeader';
import { deleteDoc, loadDocs, saveDoc, useDocs } from './docsStore';
import { extractText } from './extract';

type ActIntent = Extract<Intent, { kind: 'act' }>;

/** Lo que se enseña como respuesta. Las tareas van por id, así se ven siempre como están ahora. */
type Answer =
  | { kind: 'help' }
  | { kind: 'tasks'; label: string; ids: string[] }
  | { kind: 'done'; label: string; entries: ActivityEntry[] }
  | { kind: 'said'; person: string; mentions: Mention[] }
  | { kind: 'person'; person: string }
  | { kind: 'message'; text: string; tone: 'ok' | 'warn'; ids?: string[]; noteId?: string }
  | { kind: 'choose'; act: ActIntent; ids: string[] }
  | { kind: 'search'; query: string; hits: Hit[] };

interface Entry { id: string; question: string; answer: Answer }

// La conversación se queda mientras dure la sesión (aunque se cambie de pantalla).
let history: Entry[] = [];

/**
 * Asistente de Marea, sin IA: preguntas y órdenes con forma conocida sobre tareas, notas y personas, y búsqueda por
 * relevancia en todo, también en la documentación que sube el equipo.
 */
export function AssistantView() {
  useWideLayout(true);
  const app = useApp();
  const { tasks, notes, allProjects, peopleCards, itemTypes, today, activity, mentionables, releases, projectMap, editTask } = app;
  const { isAdmin } = useSync();
  const toast = useToast();
  const actions = useTaskActions();
  const docs = useDocs();
  const [entries, setEntries] = useState<Entry[]>(history);
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<{ doc: KnowledgeDoc; find?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const people = useMemo(() => {
    const dir = peopleDirectory(tasks, notes, peopleCards).map((p) => p.name);
    return [...new Set([...dir, ...mentionables])];
  }, [tasks, notes, peopleCards, mentionables]);
  const index = useMemo(() => new SearchIndex(buildChunks({
    tasks, notes, projects: allProjects, docs: docs.docs,
    people: people.map((name) => peopleCards.find((c) => c.name === name) ?? { name, role: '', notes: '', email: '' }),
  })), [tasks, notes, allProjects, docs.docs, people, peopleCards]);
  const captureCtx = { today, projects: allProjects, people: mentionables, types: itemTypes, releases };

  const push = (question: string, answer: Answer) => {
    history = [{ id: crypto.randomUUID(), question, answer }, ...history].slice(0, 30);
    setEntries(history);
  };

  async function runAct(act: ActIntent, task: Task) {
    const label = `${act.label}: ${task.title}`;
    switch (act.action) {
      case 'complete': await actions.toggleDone([task]); break;
      case 'reopen': await repo.setCompleted(task.id, false); break;
      case 'state': {
        const state = stateForCategory(findType(itemTypes, task.type_id), act.category!);
        await repo.batch(label, () => repo.setState(task.id, state.id));
        break;
      }
      case 'date': await repo.batch(label, async () => { await repo.updateTask(task.id, { due_date: act.date ?? null }); }); break;
      case 'my-day': await repo.batch(label, async () => { await repo.updateTask(task.id, { my_day: today }); }); break;
    }
    return label;
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q) return;
    setText('');
    const intent = parseIntent(q, { today, people, projects: allProjects });
    track('assistant-ask', intent.kind);
    try {
      switch (intent.kind) {
        case 'help': return push(q, { kind: 'help' });
        case 'tasks': return push(q, { kind: 'tasks', label: intent.label, ids: queryTasks(tasks, intent.query, { today, projects: allProjects, types: itemTypes }).map((t) => t.id) });
        case 'done': {
          const entries = activity.filter((a) => a.kind === 'completed' && a.date >= intent.from && a.date <= intent.to)
            .sort((a, b) => b.at.localeCompare(a.at));
          return push(q, { kind: 'done', label: `Hecho ${intent.label}`, entries });
        }
        case 'said': return push(q, { kind: 'said', person: intent.person, mentions: mentionsOf(intent.person, notes).slice(0, 30) });
        case 'topics': {
          const ids = tasks.filter((t) => t.type_id === TOPIC_TYPE_ID && t.status === 'todo' && !t.deleted_at && t.people.some((p) => p === intent.person)).map((t) => t.id);
          return push(q, { kind: 'tasks', label: `Para hablar con ${intent.person}`, ids });
        }
        case 'person': return push(q, { kind: 'person', person: intent.person });
        case 'create-task': {
          const parsed = parseCapture(intent.text, captureCtx).filter((p) => p.title);
          if (!parsed.length) return push(q, { kind: 'message', tone: 'warn', text: 'No sé qué tarea crear: escribe su título después de «crea una tarea».' });
          const created = await repo.batch(parsed.length === 1 ? `Tarea creada: ${parsed[0].title}` : `${parsed.length} tareas creadas`, () => submitCapture(parsed));
          track('assistant-do', 'create-task');
          return push(q, { kind: 'message', tone: 'ok', text: created.length === 1 ? 'Tarea creada:' : `${created.length} tareas creadas:`, ids: created.map((t) => t.id) });
        }
        case 'create-note': {
          if (!intent.title) return push(q, { kind: 'message', tone: 'warn', text: 'Dime el título de la nota: «crea una nota Reunión con Ana: lo que quieras apuntar».' });
          const note = await repo.createNote({ title: intent.title, body: intent.body, kind: 'note', date: today });
          track('assistant-do', 'create-note');
          return push(q, { kind: 'message', tone: 'ok', text: `Nota creada: «${note.title}».`, noteId: note.id });
        }
        case 'act': {
          const found = matchTasks(tasks, intent.query, intent.action !== 'reopen');
          if (!found.length) return push(q, { kind: 'message', tone: 'warn', text: `No encuentro ninguna tarea${intent.action === 'reopen' ? '' : ' pendiente'} que se llame «${intent.query}».` });
          // Si hay una que se llama exactamente así, o solo una, se hace; si no, se elige.
          const exact = found.filter((t) => t.title.trim().toLowerCase() === intent.query.trim().toLowerCase());
          if (found.length === 1 || exact.length === 1) {
            const label = await runAct(intent, exact[0] ?? found[0]);
            track('assistant-do', intent.action);
            return push(q, { kind: 'message', tone: 'ok', text: `${label}. Puedes deshacerlo con Cmd+Z.`, ids: [(exact[0] ?? found[0]).id] });
          }
          return push(q, { kind: 'choose', act: intent, ids: found.slice(0, 10).map((t) => t.id) });
        }
        case 'search': return push(q, { kind: 'search', query: q, hits: index.search(q, { limit: 14, sources: intent.sources }) });
      }
    } catch (e) {
      push(q, { kind: 'message', tone: 'warn', text: (e as Error).message });
    }
  }

  useEffect(() => { inputRef.current?.focus(); }, []);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const list = (ids: string[], empty = 'Nada.') => (
    <TaskList tasks={ids.map((id) => taskById.get(id)).filter((t): t is Task => !!t)} today={today} projects={projectMap} onEdit={editTask} empty={empty} />
  );

  const render = (e: Entry): ReactNode => {
    const a = e.answer;
    switch (a.kind) {
      case 'help': return <Examples onPick={(t) => void ask(t)} />;
      case 'tasks': return <><Understood>{a.label} · {a.ids.length}</Understood>{list(a.ids, 'No hay ninguna.')}</>;
      case 'done': return (
        <>
          <Understood>{a.label} · {a.entries.length}</Understood>
          {a.entries.length === 0 && <p className="text-sm text-zinc-400">No hay nada completado en ese periodo.</p>}
          <ul className="space-y-0.5 text-sm">
            {a.entries.map((x) => {
              const t = taskById.get(x.task_id);
              return (
                <li key={x.id} className="flex gap-2">
                  <span className="w-24 shrink-0 text-xs text-zinc-400">{formatDay(x.date, today)}</span>
                  {t ? <button type="button" onClick={() => editTask(t)} className="text-left hover:underline">✓ {x.title}</button> : <span>✓ {x.title}</span>}
                </li>
              );
            })}
          </ul>
        </>
      );
      case 'said': return (
        <>
          <Understood>Lo que dijo o se habló con {a.person} · {a.mentions.length}</Understood>
          {a.mentions.length === 0 && <p className="text-sm text-zinc-400">No aparece en ninguna nota.</p>}
          <ul className="space-y-1.5 text-sm">
            {a.mentions.map((m) => (
              <li key={`${m.note.id}-${m.line}`}>
                <a href={routeHref({ view: 'notes', id: m.note.id })} className="text-xs text-zinc-500 hover:underline">
                  {formatDay(m.note.date, today)} · {m.note.title}{m.section ? ` › ${m.section}` : ''}
                </a>
                <p>{m.text}</p>
              </li>
            ))}
          </ul>
          <a href={routeHref({ view: 'person', name: a.person })} className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Abrir la ficha de {a.person}</a>
        </>
      );
      case 'person': {
        const card = peopleCards.find((c) => c.name === a.person);
        const open = tasks.filter((t) => t.status === 'todo' && !t.deleted_at && t.people.includes(a.person));
        return (
          <>
            <Understood>{a.person}</Understood>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt className="text-zinc-500">Rol</dt><dd>{card?.role || '—'}</dd>
              <dt className="text-zinc-500">Email</dt><dd>{card?.email || '—'}</dd>
              {card?.notes && <><dt className="text-zinc-500">Notas</dt><dd className="whitespace-pre-wrap">{card.notes}</dd></>}
              <dt className="text-zinc-500">Pendientes</dt><dd>{open.length}</dd>
            </dl>
            {list(open.map((t) => t.id).slice(0, 10), '')}
            <a href={routeHref({ view: 'person', name: a.person })} className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Abrir la ficha</a>
          </>
        );
      }
      case 'message': return (
        <>
          <p className={`text-sm ${a.tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{a.text}</p>
          {a.ids && list(a.ids)}
          {a.noteId && <a href={routeHref({ view: 'notes', id: a.noteId })} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Abrir la nota</a>}
        </>
      );
      case 'choose': return (
        <>
          <Understood>{a.act.label}: hay varias que encajan con «{a.act.query}». ¿Cuál?</Understood>
          <ul className="space-y-1">
            {a.ids.map((id) => taskById.get(id)).filter((t): t is Task => !!t).map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => void runAct(a.act, t).then((label) => push(e.question, { kind: 'message', tone: 'ok', text: `${label}. Puedes deshacerlo con Cmd+Z.`, ids: [t.id] }))}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1 text-left text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  {t.title}{t.due_date && <span className="ml-2 text-xs text-zinc-400">{formatDay(t.due_date, today)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      );
      case 'search': return <SearchAnswer hits={a.hits} list={list} onOpenDoc={(doc, find) => setViewing({ doc, find })} docs={docs.docs} />;
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <ViewHeader
          title={<span className="inline-flex items-center gap-2"><MessagesSquare className="size-5 text-indigo-600" />Asistente</span>}
          subtitle="Pregunta o pide cosas sobre tus tareas, notas, personas y la documentación del equipo. Sin IA: entiende frases como las de los ejemplos y, si no, busca en todo."
        />
        <form onSubmit={(e) => { e.preventDefault(); void ask(text); }} className="mb-4 flex gap-2">
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} aria-label="Pregunta o petición"
            placeholder="¿Qué tengo hoy? · Tareas de Ana · ¿Qué dijo Diana? · Crea una tarea… · ¿Cómo se entrega una guía?"
            className={`${inputClass} flex-1 py-2 text-base`} />
          <button type="submit" disabled={!text.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            <CornerDownLeft className="size-4" />Preguntar
          </button>
        </form>
        {entries.length === 0 && <Examples onPick={(t) => void ask(t)} />}
        <div className="space-y-4">
          {entries.map((e) => (
            <article key={e.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
              <p className="mb-2 flex items-start gap-2 text-sm font-semibold">
                <span className="min-w-0 flex-1">{e.question}</span>
                <button type="button" onClick={() => { history = history.filter((x) => x.id !== e.id); setEntries(history); }}
                  className="rounded p-0.5 text-zinc-300 hover:text-zinc-600" aria-label="Quitar esta respuesta"><X className="size-3.5" /></button>
              </p>
              {render(e)}
            </article>
          ))}
        </div>
      </div>
      <DocsPanel isAdmin={isAdmin} onOpen={(doc) => setViewing({ doc })} />
      {viewing && <DocViewer doc={viewing.doc} find={viewing.find} onClose={() => setViewing(null)} onSaved={(d) => { setViewing({ doc: d }); toast('Documento guardado'); }} />}
    </div>
  );
}

const Understood = ({ children }: { children: ReactNode }) => <p className="mb-1.5 text-xs font-medium tracking-wide text-zinc-500 uppercase">{children}</p>;

function Examples({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2">
      {ASSISTANT_EXAMPLES.map((g) => (
        <section key={g.group}>
          <p className="mb-1 text-xs font-semibold text-zinc-500">{g.group}</p>
          <div className="flex flex-wrap gap-1">
            {g.items.map((t) => (
              <button key={t} type="button" onClick={() => onPick(t)}
                className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">{t}</button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Texto con las palabras encontradas resaltadas. */
function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    parts.push(text.slice(at, s), <mark key={s} className="rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/60">{text.slice(s, e)}</mark>);
    at = e;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function SearchAnswer({ hits, list, docs, onOpenDoc }: {
  hits: Hit[]; list: (ids: string[]) => ReactNode; docs: KnowledgeDoc[]; onOpenDoc: (doc: KnowledgeDoc, find: string) => void;
}) {
  if (!hits.length) return <p className="text-sm text-zinc-400">No encuentro nada. Prueba con otras palabras o con una de las frases de ejemplo («ayuda»).</p>;
  const taskIds = [...new Set(hits.filter((h) => h.chunk.source === 'task').map((h) => h.chunk.ref))];
  const others = hits.filter((h) => h.chunk.source !== 'task');
  return (
    <>
      <Understood>Lo que mejor encaja</Understood>
      <ul className="space-y-2.5">
        {others.map((h) => {
          const c = h.chunk;
          const doc = c.source === 'doc' ? docs.find((d) => d.id === c.ref) : undefined;
          const icon = { doc: <BookOpen className="size-3.5" />, note: <FileText className="size-3.5" />, person: <User className="size-3.5" />, project: <FolderOpen className="size-3.5" />, task: null }[c.source];
          const where = <>{icon}<span className="font-medium">{c.title}</span>{c.section && <span className="text-zinc-400">› {c.section}</span>}</>;
          return (
            <li key={c.id} className="text-sm">
              <p className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                {c.source === 'doc' && doc ? <button type="button" onClick={() => onOpenDoc(doc, h.snippet.replace(/^…|…$/g, '').slice(0, 60))} className="inline-flex items-center gap-1.5 hover:underline">{where}</button>
                  : c.source === 'note' ? <a href={routeHref({ view: 'notes', id: c.ref })} className="inline-flex items-center gap-1.5 hover:underline">{where}</a>
                    : c.source === 'person' ? <a href={routeHref({ view: 'person', name: c.ref })} className="inline-flex items-center gap-1.5 hover:underline">{where}</a>
                      : <a href={routeHref({ view: 'project', id: c.ref })} className="inline-flex items-center gap-1.5 hover:underline">{where}</a>}
              </p>
              {h.snippet && <p className="mt-0.5 text-zinc-700 dark:text-zinc-300"><Marked text={h.snippet} marks={h.marks} /></p>}
            </li>
          );
        })}
      </ul>
      {taskIds.length > 0 && <><Understood><span className="mt-3 block">Tareas</span></Understood>{list(taskIds)}</>}
    </>
  );
}

const KIND_LABEL: Record<KnowledgeDoc['kind'], string> = { text: 'Texto', markdown: 'Markdown', pdf: 'PDF', word: 'Word', other: 'Web' };
const size = (n: number) => (n < 1000 ? `${n} car.` : `${Math.round(n / 1000)} mil car.`);

/** Documentación del equipo: subir archivos o pegar texto, verla y borrar la propia (o cualquiera, si eres admin). */
function DocsPanel({ isAdmin, onOpen }: { isAdmin: boolean; onOpen: (doc: KnowledgeDoc) => void }) {
  const docs = useDocs();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [visibility, setVisibility] = useState<KnowledgeDoc['visibility']>('team');
  const [busy, setBusy] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setBusy(`Leyendo ${file.name}…`);
      try {
        const x = await extractText(file);
        setBusy(`Guardando ${file.name}…`);
        await saveDoc({ title: x.title, kind: x.kind, fileName: file.name, body: x.body, visibility });
        track('assistant-doc', x.kind);
        toast(`«${x.title}» añadido a la documentación`);
      } catch (e) {
        toast((e as Error).message);
      }
    }
    setBusy(null);
  };

  return (
    <aside className="space-y-3 self-start rounded-lg border border-zinc-200 bg-white p-3 text-sm lg:sticky lg:top-4 dark:border-zinc-700 dark:bg-zinc-900"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
      <h2 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />Documentación <span className="font-normal text-zinc-400">{docs.docs.length}</span></h2>
      <p className="text-xs text-zinc-500">Guías, procesos, PDFs o Word para que el Asistente busque en ellos. Se guarda solo el texto.</p>
      <div className={`rounded-md border-2 border-dashed p-3 text-center text-xs ${dragging ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950' : 'border-zinc-200 dark:border-zinc-700'}`}>
        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json"
          onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
        <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          <Upload className="size-4" />Subir archivos
        </button>
        <p className="mt-1 text-zinc-400">o arrástralos aquí · PDF, Word, Markdown, texto</p>
        <button type="button" onClick={() => setPasting(true)} className="mt-1 text-indigo-600 hover:underline dark:text-indigo-400">o pega un texto</button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500">Al subir:</span>
        {(['team', 'private'] as const).map((v) => (
          <label key={v} className="inline-flex items-center gap-1">
            <input type="radio" checked={visibility === v} onChange={() => setVisibility(v)} />{v === 'team' ? 'para todo el equipo' : 'solo para mí'}
          </label>
        ))}
      </div>
      {busy && <p className="text-xs text-zinc-500">{busy}</p>}
      {docs.error && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{docs.error}</p>}
      <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
        {docs.docs.map((d) => (
          <li key={d.id} className="group flex items-start gap-2 rounded-md px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800">
            <button type="button" onClick={() => onOpen(d)} className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-1 font-medium">
                {d.visibility === 'private' ? <Lock className="size-3 shrink-0 text-zinc-400" /> : <Users className="size-3 shrink-0 text-zinc-400" />}
                <span className="truncate">{d.title}</span>
              </span>
              <span className="block text-xs text-zinc-400">{KIND_LABEL[d.kind]} · {size(d.size)} · {d.ownerName || '—'}</span>
            </button>
            {(d.mine || isAdmin) && (
              <button type="button" aria-label={`Borrar ${d.title}`} className="rounded p-1 text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-600"
                onClick={() => { if (confirm(`¿Borrar «${d.title}» de la documentación${d.visibility === 'team' ? ' del equipo' : ''}?`)) void deleteDoc(d.id).catch((e: Error) => toast(e.message)); }}>
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {docs.loaded && !docs.error && docs.docs.length === 0 && <li className="text-xs text-zinc-400">Aún no hay documentos.</li>}
      </ul>
      {docs.loaded && <button type="button" onClick={() => loadDocs(true)} className="text-xs text-zinc-400 hover:text-zinc-700">Volver a cargar</button>}
      {pasting && <PasteDoc visibility={visibility} onClose={() => setPasting(false)} />}
    </aside>
  );
}

function PasteDoc({ visibility, onClose }: { visibility: KnowledgeDoc['visibility']; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await saveDoc({ title: title.trim(), kind: 'markdown', fileName: '', body, visibility });
      track('assistant-doc', 'paste');
      toast(`«${title.trim()}» añadido a la documentación`);
      onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal title="Pegar un texto" onClose={onClose} wide>
      <div className="space-y-2 text-sm">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (p. ej. Guía de entrega)" className={inputClass} />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} placeholder={'Pega aquí el texto. Los títulos con «# » separan los apartados.'}
          className={`${inputClass} resize-y font-mono text-xs`} />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
          <button type="button" disabled={!title.trim() || !body.trim()} onClick={() => void save()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Guardar</button>
        </div>
      </div>
    </Modal>
  );
}

/** Ver un documento (y, si es tuyo o eres admin, cambiarle el título o el texto); con `find`, se va a ese trozo. */
function DocViewer({ doc, find, onClose, onSaved }: { doc: KnowledgeDoc; find?: string; onClose: () => void; onSaved: (d: KnowledgeDoc) => void }) {
  const { isAdmin } = useSync();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.body);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!find || !ref.current) return;
    const el = [...ref.current.querySelectorAll('p')].find((p) => p.textContent?.replace(/\s+/g, ' ').includes(find.slice(0, 40)));
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('bg-amber-50', 'dark:bg-amber-950/40'); }
  }, [find]);
  const canEdit = doc.mine || isAdmin;
  return (
    <Modal title={doc.title} onClose={onClose} wide>
      <p className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
        {KIND_LABEL[doc.kind]}{doc.fileName ? ` · ${doc.fileName}` : ''} · {doc.visibility === 'team' ? 'para todo el equipo' : 'solo para ti'} · de {doc.ownerName || '—'}
        {canEdit && !editing && <button type="button" onClick={() => setEditing(true)} className="ml-auto font-medium text-indigo-600 hover:underline dark:text-indigo-400">Editar</button>}
      </p>
      {editing ? (
        <div className="space-y-2 text-sm">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} aria-label="Título" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={18} className={`${inputClass} resize-y font-mono text-xs`} aria-label="Texto" />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
            <button type="button" onClick={() => void saveDoc({ id: doc.id, title, kind: doc.kind, fileName: doc.fileName, body, visibility: doc.visibility }).then(onSaved, (e: Error) => setError(e.message))}
              className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">Guardar</button>
          </div>
        </div>
      ) : (
        <div ref={ref} className="max-h-[65vh] space-y-2 overflow-y-auto text-sm leading-relaxed">
          {doc.body.split(/\n{2,}/).map((block, i) => {
            const h = /^(#{1,6})\s+(.+)$/.exec(block.trim());
            return h ? <h3 key={i} className="pt-2 font-semibold">{h[2]}</h3> : <p key={i} className="rounded px-1 whitespace-pre-wrap">{block}</p>;
          })}
        </div>
      )}
      {!editing && doc.kind === 'pdf' && <p className="mt-2 flex items-center gap-1 text-xs text-zinc-400"><ExternalLink className="size-3" />Es el texto sacado del PDF (sin imágenes ni formato).</p>}
    </Modal>
  );
}
