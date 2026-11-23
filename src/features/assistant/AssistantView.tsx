import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, CornerDownLeft, ExternalLink, FileText, FolderOpen, MessagesSquare, Puzzle, RefreshCw, Upload, User, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { routeHref } from '../../app/router';
import { TaskList } from '../../components/TaskList';
import { useToast } from '../../components/Toast';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import { ASSISTANT_EXAMPLES, buildChunks, matchTasks, parseIntent, queryTasks, type Intent } from '../../domain/assistant';
import { formatDay } from '../../domain/dates';
import { SearchIndex, terms, type Hit } from '../../domain/knowledge';
import { mentionsOf, type Mention } from '../../domain/notes';
import { peopleDirectory } from '../../domain/people';
import { TOPIC_TYPE_ID, type ActivityEntry, type Task } from '../../domain/types';
import { findType, stateForCategory } from '../../domain/workflows';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useTaskActions } from '../../hooks/useTaskActions';
import { parseCapture } from '../../parser/parseCapture';
import { submitCapture } from '../capture/submitCapture';
import { track } from '../usage/track';
import { ViewHeader } from '../views/ViewHeader';
import { extDocs, useExtension } from '../mslist/extension';
import { kqlFrom, summaryMarks } from './spDocs';

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
  const actions = useTaskActions();
  const [entries, setEntries] = useState<Entry[]>(history);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const people = useMemo(() => {
    const dir = peopleDirectory(tasks, notes, peopleCards).map((p) => p.name);
    return [...new Set([...dir, ...mentionables])];
  }, [tasks, notes, peopleCards, mentionables]);
  const index = useMemo(() => new SearchIndex(buildChunks({
    tasks, notes, projects: allProjects, docs: [],
    people: people.map((name) => peopleCards.find((c) => c.name === name) ?? { name, role: '', notes: '', email: '' }),
  })), [tasks, notes, allProjects, people, peopleCards]);
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
        case 'search': return push(q, { kind: 'search', query: q, hits: index.search(q, { limit: 14 }) });
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
      case 'search': return <><SharePointHits query={a.query} /><SearchAnswer hits={a.hits} list={list} /></>;
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
      <SharePointPanel />
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

function SearchAnswer({ hits, list }: { hits: Hit[]; list: (ids: string[]) => ReactNode }) {
  if (!hits.length) return <p className="text-sm text-zinc-400">En Marea no encuentro nada. Prueba con otras palabras o con una de las frases de ejemplo («ayuda»).</p>;
  const taskIds = [...new Set(hits.filter((h) => h.chunk.source === 'task').map((h) => h.chunk.ref))];
  const others = hits.filter((h) => h.chunk.source !== 'task');
  return (
    <>
      {others.length > 0 && <Understood>En Marea</Understood>}
      <ul className="space-y-2.5">
        {others.map((h) => {
          const c = h.chunk;
          const icon = { doc: <BookOpen className="size-3.5" />, note: <FileText className="size-3.5" />, person: <User className="size-3.5" />, project: <FolderOpen className="size-3.5" />, task: null }[c.source];
          const where = <>{icon}<span className="font-medium">{c.title}</span>{c.section && <span className="text-zinc-400">› {c.section}</span>}</>;
          return (
            <li key={c.id} className="text-sm">
              <p className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
                {c.source === 'note' ? <a href={routeHref({ view: 'notes', id: c.ref })} className="inline-flex items-center gap-1.5 hover:underline">{where}</a>
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

/** Dónde busca el Asistente en SharePoint (de cada persona, en este navegador). */
interface SpConfig { siteUrl: string; siteTitle: string; folder: string; folderName: string; folderUrl: string; scope: 'site' | 'folder' }

const useSpConfig = () => usePersistentState<SpConfig | null>('asistente-sharepoint', null);

interface SpHit { title: string; url: string; summary: string; author: string; modified: string; type: string }

/** Resultados del buscador de SharePoint para la pregunta (por la extensión), en todo el sitio o en la carpeta. */
function SharePointHits({ query }: { query: string }) {
  const [config] = useSpConfig();
  const extension = useExtension();
  const [state, setState] = useState<{ hits: SpHit[]; loose: boolean } | { error: string } | null>(null);
  const kql = kqlFrom(query, (w) => !terms(w).length);
  const scope = config ? (config.scope === 'folder' ? config.folderUrl : config.siteUrl) : '';
  useEffect(() => {
    if (!config || !extension || !kql) return;
    let alive = true;
    extDocs<{ hits: SpHit[]; loose: boolean }>('search', { siteUrl: config.siteUrl, scope, query: kql.query, orQuery: kql.orQuery, limit: 8 })
      .then((r) => { if (alive) setState(r); }, (e: Error) => { if (alive) setState({ error: e.message }); });
    return () => { alive = false; };
  }, [query, scope, extension]); // eslint-disable-line react-hooks/exhaustive-deps -- kql sale de query
  if (!config || !kql) return null;
  const where = config.scope === 'folder' ? `la carpeta «${config.folderName}»` : `el sitio «${config.siteTitle}»`;
  if (!extension) return <p className="mb-3 text-xs text-zinc-400">Para buscar también en {where} de SharePoint hace falta la extensión «Marea · Lista».</p>;
  return (
    <section className="mb-3">
      <Understood>En SharePoint · {where}</Understood>
      {!state && <p className="text-sm text-zinc-400">Buscando en SharePoint…</p>}
      {state && 'error' in state && <p className="text-sm text-amber-700 dark:text-amber-300">{state.error}</p>}
      {state && 'hits' in state && state.hits.length === 0 && <p className="text-sm text-zinc-400">No hay documentos que encajen.</p>}
      {state && 'hits' in state && state.loose && state.hits.length > 0 && <p className="mb-1 text-xs text-zinc-400">Ninguno tiene todas las palabras; estos tienen alguna.</p>}
      {state && 'hits' in state && (
        <ul className="space-y-2.5">
          {state.hits.map((h) => {
            const sum = summaryMarks(h.summary);
            return (
              <li key={h.url} className="text-sm">
                <a href={h.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 hover:underline dark:text-zinc-200">
                  <FileText className="size-3.5" />{h.title || h.url.split('/').pop()}
                  {h.type && <span className="rounded bg-zinc-100 px-1 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">{h.type}</span>}
                  <ExternalLink className="size-3 text-zinc-400" />
                </a>
                {sum.text && <p className="mt-0.5 text-zinc-700 dark:text-zinc-300"><Marked text={sum.text} marks={sum.marks} /></p>}
                <p className="text-[11px] text-zinc-400">{[h.author.split(';')[0], h.modified ? new Date(h.modified).toLocaleDateString('es') : ''].filter(Boolean).join(' · ')}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const MAX_UPLOAD = 15 * 1024 * 1024;
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Documentación en SharePoint: la carpeta del equipo (se pega su dirección o su enlace de «compartir»), si se busca en
 * todo el sitio o solo en ella, subir archivos a la carpeta y los más recientes. Todo por la extensión, con tu sesión.
 */
function SharePointPanel() {
  const extension = useExtension();
  const toast = useToast();
  const [config, setConfig] = useSpConfig();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; url: string; modified: string; size: number }[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFiles = (c = config) => {
    if (!c || !extension) return;
    extDocs<{ files: { name: string; url: string; modified: string; size: number }[] }>('list', { siteUrl: c.siteUrl, folder: c.folder })
      .then((r) => setFiles(r.files), (e: Error) => setError(e.message));
  };
  useEffect(() => { loadFiles(); }, [config?.folder, extension]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy('Buscando la carpeta…');
    setError(null);
    try {
      const r = await extDocs<Omit<SpConfig, 'scope'>>('resolve', { url: link.trim() });
      const next = { ...r, scope: config?.scope ?? 'site' } as SpConfig;
      setConfig(next);
      setLink('');
      track('assistant-sharepoint', 'connect');
      loadFiles(next);
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  const upload = async (list: FileList | File[]) => {
    if (!config) return;
    for (const file of Array.from(list)) {
      if (file.size > MAX_UPLOAD) { toast(`«${file.name}» pesa ${kb(file.size)}: desde aquí se suben hasta 15 MB. Súbelo directamente en SharePoint.`); continue; }
      setBusy(`Subiendo ${file.name}…`);
      try {
        const r = await extDocs<{ name: string; url: string }>('upload', { siteUrl: config.siteUrl, folder: config.folder, name: file.name, base64: toBase64(await file.arrayBuffer()) }, 180_000);
        track('assistant-sharepoint', 'upload');
        toast(`«${r.name}» subido a «${config.folderName}». SharePoint tarda unos minutos en tenerlo en su buscador.`);
      } catch (e) { toast((e as Error).message); }
    }
    setBusy(null);
    loadFiles();
  };

  const card = 'space-y-3 self-start rounded-lg border border-zinc-200 bg-white p-3 text-sm lg:sticky lg:top-4 dark:border-zinc-700 dark:bg-zinc-900';
  if (!extension) {
    return (
      <aside className={card}>
        <h2 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />Documentación en SharePoint</h2>
        <p className="text-xs text-zinc-500">
          Para buscar en los documentos del equipo (Word, PDF, PowerPoint…) y subir nuevos hace falta la extensión de Chrome «Marea · Lista», con tu
          sesión de SharePoint. Sin ella, el Asistente busca igual en tus tareas, notas y personas.
        </p>
        <a href={routeHref({ view: 'lista' })} className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          <Puzzle className="size-3.5" />Instalar la extensión (Lista → Conectar)
        </a>
      </aside>
    );
  }
  return (
    <aside className={card}
      onDragOver={(e) => { if (config) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (config && e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
      <h2 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />Documentación en SharePoint</h2>
      {config ? (
        <>
          <p className="text-xs">
            <a href={config.folderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
              <FolderOpen className="size-3.5" />{config.folderName}<ExternalLink className="size-3 text-zinc-400" />
            </a>
            <span className="block text-zinc-400">en el sitio {config.siteTitle}</span>
          </p>
          <div className="space-y-0.5 text-xs">
            <span className="text-zinc-500">Buscar en:</span>
            <label className="flex items-center gap-1.5"><input type="radio" checked={config.scope === 'site'} onChange={() => setConfig({ ...config, scope: 'site' })} />todo el sitio «{config.siteTitle}»</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={config.scope === 'folder'} onChange={() => setConfig({ ...config, scope: 'folder' })} />solo la carpeta «{config.folderName}»</label>
          </div>
          <div className={`rounded-md border-2 border-dashed p-3 text-center text-xs ${dragging ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950' : 'border-zinc-200 dark:border-zinc-700'}`}>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
            <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
              <Upload className="size-4" />Subir a la carpeta
            </button>
            <p className="mt-1 text-zinc-400">o arrastra los archivos aquí (hasta 15 MB)</p>
          </div>
          {busy && <p className="text-xs text-zinc-500">{busy}</p>}
          {error && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold text-zinc-500">
              Últimos de la carpeta
              <button type="button" onClick={() => loadFiles()} aria-label="Volver a cargar" className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"><RefreshCw className="size-3" /></button>
            </p>
            {files === null && <p className="text-xs text-zinc-400">Cargando…</p>}
            {files && files.length === 0 && <p className="text-xs text-zinc-400">La carpeta está vacía.</p>}
            <ul className="max-h-[40vh] space-y-0.5 overflow-y-auto">
              {files?.map((f) => (
                <li key={f.url}>
                  <a href={f.url} target="_blank" rel="noreferrer" className="block truncate rounded px-1 py-0.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800" title={f.name}>
                    {f.name} <span className="text-zinc-400">· {kb(f.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <button type="button" onClick={() => { if (confirm('¿Dejar de usar esta carpeta? En SharePoint no se borra nada.')) { setConfig(null); setFiles(null); } }}
            className="text-xs text-zinc-400 hover:text-zinc-700">Cambiar de carpeta</button>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            Pega la dirección de la carpeta de documentación del equipo (la del navegador o su enlace de «compartir»). El Asistente buscará con el
            buscador de SharePoint en todo su sitio, sin descargar nada, y cada persona solo verá lo que puede abrir.
          </p>
          <div className="flex gap-2">
            <input value={link} onChange={(e) => { setLink(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && link.trim()) void connect(); }}
              placeholder="https://….sharepoint.com/…" aria-label="Dirección de la carpeta" className={`${inputClass} min-w-0 flex-1 py-1`} />
            <button type="button" disabled={!link.trim() || !!busy} onClick={() => void connect()}
              className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Usar</button>
          </div>
          {busy && <p className="text-xs text-zinc-500">{busy}</p>}
          {error && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
        </>
      )}
    </aside>
  );
}
