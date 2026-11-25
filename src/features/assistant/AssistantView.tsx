import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronRight, CornerDownLeft, ExternalLink, FileText, FolderOpen, ListChecks, MessagesSquare, Plus, Puzzle, RefreshCw, Upload, User, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { routeHref } from '../../app/router';
import { TaskList } from '../../components/TaskList';
import { useToast } from '../../components/Toast';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import { doneSummary, extractAnswer, personSummary, saidSummary, scoreSentence, sentences, tasksSummary, topicsSummary } from '../../domain/answer';
import { ASSISTANT_EXAMPLES, buildChunks, matchTasks, parseIntent, queryTasks, type Intent } from '../../domain/assistant';
import { formatDay } from '../../domain/dates';
import { SearchIndex, terms, type Chunk, type Hit } from '../../domain/knowledge';
import { mentionsOf, type Mention } from '../../domain/notes';
import { peopleDirectory } from '../../domain/people';
import { TOPIC_TYPE_ID, type ActivityEntry, type Task } from '../../domain/types';
import { findType, stateForCategory, stateOf } from '../../domain/workflows';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useTaskActions } from '../../hooks/useTaskActions';
import { parseCapture } from '../../parser/parseCapture';
import { submitCapture } from '../capture/submitCapture';
import { track } from '../usage/track';
import { ViewHeader } from '../views/ViewHeader';
import { extDocs, useExtension } from '../mslist/extension';
import { currentItems, loadListaConfig, useLista } from '../mslist/listaStore';
import { folderKey, folderState, loadFolderDocs, useFolderDocs } from './folderDocs';
import { confluenceChunks, isConfluenceChunk, loadConfluenceDocs, useConfluenceDocs } from './confluenceDocs';
import { kqlFrom, summaryMarks } from './spDocs';
import { AiAnswer, AiPanel, useAiEnabled } from './ai/AiAnswer';
import { AskClaudeButton, ClaudeCard } from './askClaude';
import { indexChunks, startLlm, useAi } from './ai/engine';

type ActIntent = Extract<Intent, { kind: 'act' }>;

/** Lo que se enseña como respuesta. Las tareas van por id, así se ven siempre como están ahora. */
type Answer =
  | { kind: 'help' }
  | { kind: 'tasks'; label: string; ids: string[]; topicsWith?: string }
  | { kind: 'done'; label: string; entries: ActivityEntry[] }
  | { kind: 'said'; person: string; mentions: Mention[] }
  | { kind: 'person'; person: string }
  | { kind: 'message'; text: string; tone: 'ok' | 'warn'; ids?: string[]; noteId?: string }
  | { kind: 'choose'; act: ActIntent; ids: string[] }
  | { kind: 'search'; query: string; hits: Hit[]; /** Lo encontrado por palabras para la IA (más que lo que se enseña). */ rag?: Chunk[] };

interface Entry { id: string; question: string; answer: Answer }

/**
 * Envuelve el resultado de una búsqueda. La entrada más reciente se ve entera; las anteriores se pliegan a una línea «Ver
 * respuesta» para no llenar la pantalla. Los hijos siguen montados (solo ocultos con `hidden`), así la IA no se recalcula al
 * plegar. Al llegar una pregunta nueva, la anterior se pliega sola.
 */
function Collapsible({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  useEffect(() => { setOpen(!collapsed); }, [collapsed]);
  return (
    <>
      {collapsed && (
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{open ? 'Ocultar respuesta' : 'Ver respuesta'}
        </button>
      )}
      <div className={open ? '' : 'hidden'}>{children}</div>
    </>
  );
}

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
  const [sources] = useSpSources();
  const extension = useExtension();
  const folderDocs = useFolderDocs();
  const lista = useLista();
  const listItems = useMemo(() => currentItems(lista), [lista]);
  // Los documentos de cada carpeta se leen al entrar (y después solo los que cambian).
  const sourceKeys = sources.map((c) => folderKey(c.siteUrl, c.folder)).join();
  useEffect(() => { if (extension) for (const c of sources) void loadFolderDocs(c.siteUrl, c.folder); }, [sourceKeys, extension]); // eslint-disable-line react-hooks/exhaustive-deps
  const allDocs = useMemo(() => sources.flatMap((c) => folderState(folderDocs, c.siteUrl, c.folder).docs), [sources, folderDocs]);
  // La documentación de Confluence (Supabase, la misma del conector MCP), al entrar y si ha cambiado.
  const confluence = useConfluenceDocs();
  useEffect(() => { void loadConfluenceDocs(); }, []);
  const [entries, setEntries] = useState<Entry[]>(history);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const people = useMemo(() => {
    const dir = peopleDirectory(tasks, notes, peopleCards).map((p) => p.name);
    return [...new Set([...dir, ...mentionables])];
  }, [tasks, notes, peopleCards, mentionables]);
  const chunks = useMemo(() => buildChunks({
    tasks, notes, projects: allProjects,
    docs: allDocs.map((d) => ({ id: d.url, title: d.name.replace(/\.[^.]+$/, ''), body: d.text })),
    listItems,
    people: people.map((name) => peopleCards.find((c) => c.name === name) ?? { name, role: '', notes: '', email: '' }),
  }).concat(confluenceChunks(confluence.pages)), [tasks, notes, allProjects, people, peopleCards, allDocs, listItems, confluence.pages]);
  const index = useMemo(() => new SearchIndex(chunks), [chunks]);
  // IA local (si la persona la ha activado): se carga el modelo y se indexa por significado en segundo plano.
  const [aiEnabled] = useAiEnabled();
  const ai = useAi();
  const aiOn = aiEnabled && ai.llm !== 'unsupported' && ai.llm !== 'error';
  useEffect(() => { if (aiEnabled) void startLlm(); }, [aiEnabled]);
  useEffect(() => {
    if (!aiEnabled) return;
    const t = setTimeout(() => void indexChunks(chunks), 1500);
    return () => clearTimeout(t);
  }, [aiEnabled, chunks]);
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
          return push(q, { kind: 'done', label: intent.label, entries });
        }
        case 'said': return push(q, { kind: 'said', person: intent.person, mentions: mentionsOf(intent.person, notes).slice(0, 30) });
        case 'topics': {
          const ids = tasks.filter((t) => t.type_id === TOPIC_TYPE_ID && t.status === 'todo' && !t.deleted_at && t.people.some((p) => p === intent.person)).map((t) => t.id);
          return push(q, { kind: 'tasks', label: `Para hablar con ${intent.person}`, ids, topicsWith: intent.person });
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
        case 'search': return push(q, { kind: 'search', query: q, hits: index.search(q, { limit: 14 }), rag: index.search(q, { limit: 30 }).map((h) => h.chunk) });
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

  // Solo la respuesta de búsqueda más reciente (las responde la IA) se ve entera; las anteriores quedan plegadas para no
  // llenar la pantalla. `entries` va de la más nueva a la más vieja, así que la primera de tipo «search» es la última hecha.
  const latestAiId = entries.find((x) => x.answer.kind === 'search')?.id;
  const render = (e: Entry): ReactNode => {
    const a = e.answer;
    switch (a.kind) {
      case 'help': return <Examples onPick={(t) => void ask(t)} />;
      case 'tasks': {
        const found = a.ids.map((id) => taskById.get(id)).filter((t): t is Task => !!t);
        const blocked = found.filter((t) => t.status === 'todo' && stateOf(itemTypes, t).category === 'blocked').length;
        return (
          <>
            <Lead text={a.topicsWith ? topicsSummary(a.topicsWith, found) : tasksSummary(found, a.label.toLowerCase(), today, a.label.toLowerCase().includes('bloquead') ? 0 : blocked)} />
            <Understood>{a.label} · {a.ids.length}</Understood>{list(a.ids, '')}
          </>
        );
      }
      case 'done': return (
        <>
          <Lead text={doneSummary(a.entries, a.label)} />
          <Understood>Hecho {a.label} · {a.entries.length}</Understood>
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
          <Lead text={saidSummary(a.person, a.mentions, today)} />
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
            <Lead text={personSummary(a.person, card, open.length)} />
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
      case 'search': {
        const answer = extractAnswer(a.hits, a.query);
        const local = a.hits.filter((h) => h.chunk.source === 'doc');
        const fromList = a.hits.filter((h) => h.chunk.source === 'list');
        // Cada documento, en el bloque de su carpeta.
        const folderOf = (url: string) => sources.find((c) => folderState(folderDocs, c.siteUrl, c.folder).docs.some((d) => d.url === url));
        const fromConfluence = local.filter((h) => isConfluenceChunk(h.chunk));
        const source = answer && sourceOf(answer.hit, isConfluenceChunk(answer.hit.chunk) ? 'Confluence' : sources.find((c) => c === folderOf(answer.hit.chunk.ref))?.folderName);
        return (
          <Collapsible collapsed={e.id !== latestAiId}>
            {aiOn
              ? <AiAnswer entryId={e.id} query={a.query} keywordHits={a.rag ?? a.hits.map((h) => h.chunk)} chunks={chunks} today={today}
                  onTask={(id) => { const t = taskById.get(id); if (t) editTask(t); }} />
              : answer && source && <Lead text={answer.sentence.text} marks={answer.sentence.marks} source={source.label} href={source.href} external={source.external} />}
            {sources.map((c) => {
              const mine = local.filter((h) => folderOf(h.chunk.ref) === c);
              return mine.length > 0 && <FolderHits key={c.id} hits={mine} folderName={c.folderName} />;
            })}
            {fromConfluence.length > 0 && <FolderHits hits={fromConfluence} folderName="Confluence" title="En Confluence" />}
            {fromList.length > 0 && <ListHits hits={fromList} />}
            {sources.map((c, i) => <SharePointHits key={c.id} source={c} query={a.query} skip={new Set(local.map((h) => h.chunk.ref))} lead={!answer && i === 0} />)}
            <SearchAnswer hits={a.hits.filter((h) => h.chunk.source !== 'doc' && h.chunk.source !== 'list')} list={list} />
            <AskClaudeButton entryId={e.id} question={a.query} />
          </Collapsible>
        );
      }
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <ViewHeader
          title={<span className="inline-flex items-center gap-2"><MessagesSquare className="size-5 text-indigo-600" />Asistente</span>}
          subtitle={aiOn
            ? 'Pregunta o pide cosas sobre tus tareas, notas, personas, la Lista y la documentación del equipo en Confluence y SharePoint. Las preguntas abiertas las responde la IA de tu ordenador con lo que encuentra.'
            : 'Pregunta o pide cosas sobre tus tareas, notas, personas, la Lista y la documentación del equipo en Confluence y SharePoint. Entiende frases como las de los ejemplos y, si no, busca en todo. Activa las respuestas con IA en el panel.'}
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
      <div className="space-y-4">
        <AiPanel />
        <ConfluenceCard />
        <ClaudeCard />
        <SharePointPanel />
      </div>
    </div>
  );
}

/**
 * La respuesta, arriba: una frase (resumen de lo encontrado o la frase de un documento que mejor responde) y, si sale
 * de un sitio, su fuente con enlace. Sin IA: no se inventa nada.
 */
function Lead({ text, marks, source, href, external }: { text: string; marks?: [number, number][]; source?: string; href?: string; external?: boolean }) {
  return (
    <div className="mb-3 rounded-md border-l-4 border-indigo-500 bg-indigo-50/60 px-3 py-2 text-sm dark:bg-indigo-950/40">
      <p className="text-zinc-800 dark:text-zinc-100">{source && <span className="text-zinc-500">Según {source}: </span>}{marks ? <>«<Marked text={text} marks={marks} />»</> : text}</p>
      {href && (
        <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Abrir la fuente{external && <ExternalLink className="size-3" />}
        </a>
      )}
    </div>
  );
}

/** De dónde sale una frase de respuesta, para citarla. */
function sourceOf(hit: Hit, folderName?: string): { label: string; href: string; external: boolean } | null {
  const c = hit.chunk;
  const title = `«${c.title}»${c.section ? ` (${c.section})` : ''}`;
  switch (c.source) {
    case 'doc': return { label: `${title}${folderName ? ` en ${folderName}` : ''}`, href: c.ref, external: true };
    case 'note': return { label: `la nota ${title}`, href: routeHref({ view: 'notes', id: c.ref }), external: false };
    case 'list': return { label: `la Lista, elemento ${title}`, href: routeHref({ view: 'lista' }), external: false };
    case 'person': return { label: `la ficha de ${c.title}`, href: routeHref({ view: 'person', name: c.ref }), external: false };
    default: return null;
  }
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

/** Lo encontrado en los documentos de la carpeta (leídos directamente, así salen al momento). */
function FolderHits({ hits, folderName, title }: { hits: Hit[]; folderName: string; title?: string }) {
  const seen = new Set<string>();
  return (
    <section className="mb-3">
      <Understood>{title ?? `En la carpeta «${folderName}»`}</Understood>
      <ul className="space-y-2.5">
        {hits.filter((h) => { const k = `${h.chunk.ref}|${h.chunk.section ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5).map((h) => (
          <li key={h.chunk.id} className="text-sm">
            <a href={h.chunk.ref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 hover:underline dark:text-zinc-200">
              <BookOpen className="size-3.5" />{h.chunk.title}{h.chunk.section && <span className="font-normal text-zinc-400">› {h.chunk.section}</span>}
              <ExternalLink className="size-3 text-zinc-400" />
            </a>
            <p className="mt-0.5 text-zinc-700 dark:text-zinc-300"><Marked text={h.snippet} marks={h.marks} /></p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Nombre del sitio (si SharePoint no lo dio, el final de su dirección). */
const siteName = (c: { siteTitle: string; siteUrl: string }) => c.siteTitle || decodeURIComponent(c.siteUrl.split('/').filter(Boolean).pop() ?? '');

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
          const icon = { doc: <BookOpen className="size-3.5" />, note: <FileText className="size-3.5" />, person: <User className="size-3.5" />, project: <FolderOpen className="size-3.5" />, list: <ListChecks className="size-3.5" />, task: null }[c.source];
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

/** Una carpeta de documentación en SharePoint (puede ser de WPP, de La Caixa…): de cada persona, en este navegador. */
interface SpSource { id: string; siteUrl: string; siteTitle: string; folder: string; folderName: string; folderUrl: string; scope: 'site' | 'folder' }

/** Las carpetas del Asistente (la de antes, de una sola carpeta, se sigue leyendo). */
function useSpSources(): [SpSource[], (list: SpSource[]) => void] {
  const [list, setList] = usePersistentState<SpSource[] | null>('asistente-sharepoint-v2', null);
  const [old] = usePersistentState<Omit<SpSource, 'id'> | null>('asistente-sharepoint', null);
  return [list ?? (old ? [{ ...old, id: 'primera' }] : []), setList];
}

interface SpHit { title: string; url: string; summary: string; author: string; modified: string; type: string }

/** Elementos de la Microsoft List que encajan (enlace a SharePoint, su estado y, si la hay, su tarea del gestor). */
function ListHits({ hits }: { hits: Hit[] }) {
  const lista = useLista();
  const { tasks, editTask } = useApp();
  const items = currentItems(lista);
  const status = loadListaConfig().statusColumn;
  return (
    <section className="mb-3">
      <Understood>En la Lista «{lista.snapshot?.title ?? 'Lista'}»</Understood>
      <ul className="space-y-2.5">
        {hits.slice(0, 6).map((h) => {
          const it = items.find((x) => x.id === h.chunk.ref);
          if (!it) return null;
          const task = tasks.find((t) => !t.deleted_at && t.external_id === `LS-${it.id}`);
          return (
            <li key={h.chunk.id} className="text-sm">
              <p className="flex flex-wrap items-center gap-1.5 text-xs">
                <ListChecks className="size-3.5 text-teal-600" />
                {it.url ? <a href={it.url} target="_blank" rel="noreferrer" className="font-medium text-zinc-700 hover:underline dark:text-zinc-200">{it.title}</a> : <span className="font-medium">{it.title}</span>}
                <span className="text-zinc-400">#{it.id}</span>
                {status && it.fields[status] && <span className="rounded-full bg-teal-50 px-1.5 text-teal-700 dark:bg-teal-950 dark:text-teal-300">{it.fields[status]}</span>}
                {task && <button type="button" onClick={() => editTask(task)} className="text-emerald-700 hover:underline dark:text-emerald-400">En el gestor</button>}
              </p>
              {h.snippet && <p className="mt-0.5 text-zinc-700 dark:text-zinc-300"><Marked text={h.snippet} marks={h.marks} /></p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Si en Marea no hay respuesta: la frase del resumen de SharePoint que mejor responde, con su documento. */
function SharePointLead({ hits, query, where }: { hits: SpHit[]; query: string; where: string }) {
  const q = [...new Set(terms(query))];
  let best: { text: string; marks: [number, number][]; score: number; hit: SpHit } | null = null;
  for (const [rank, hit] of hits.slice(0, 4).entries()) {
    for (const s of sentences(summaryMarks(hit.summary).text.replace(/…/g, '. '))) {
      const scored = scoreSentence(s, q);
      scored.score *= 1 - rank * 0.05;
      if (!best || scored.score > best.score) best = { ...scored, hit };
    }
  }
  if (!best || best.score < (q.length === 1 ? 1 : 0.5)) return null;
  return <Lead text={best.text} marks={best.marks} source={`«${best.hit.title || best.hit.url.split('/').pop()}» (${where})`} href={best.hit.url} external />;
}

/** Resultados del buscador de SharePoint para la pregunta (por la extensión), en todo el sitio o en la carpeta. */
function SharePointHits({ source: config, query, skip, lead }: { source: SpSource; query: string; skip: Set<string>; lead?: boolean }) {
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
  const where = config.scope === 'folder' ? `la carpeta «${config.folderName}»` : `el sitio «${siteName(config)}»`;
  // Lo que ya ha salido «En la carpeta» no se repite.
  const same = (u: string) => { try { return skip.has(u) || skip.has(encodeURI(decodeURI(u))); } catch { return skip.has(u); } };
  if (!extension) return <p className="mb-3 text-xs text-zinc-400">Para buscar también en {where} de SharePoint hace falta la extensión «Marea · Lista».</p>;
  return (
    <section className="mb-3">
      {lead && state && 'hits' in state && <SharePointLead hits={state.hits} query={query} where={where} />}
      <Understood>En SharePoint · {where}</Understood>
      {!state && <p className="text-sm text-zinc-400">Buscando en SharePoint…</p>}
      {state && 'error' in state && <p className="text-sm text-amber-700 dark:text-amber-300">{state.error}</p>}
      {state && 'hits' in state && state.hits.length === 0 && <p className="text-sm text-zinc-400">No hay documentos que encajen.</p>}
      {state && 'hits' in state && state.loose && state.hits.length > 0 && <p className="mb-1 text-xs text-zinc-400">Ninguno tiene todas las palabras; estos tienen alguna.</p>}
      {state && 'hits' in state && (
        <ul className="space-y-2.5">
          {state.hits.filter((h) => !same(h.url)).map((h) => {
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

const card = 'space-y-3 self-start rounded-lg border border-zinc-200 bg-white p-3 text-sm lg:sticky lg:top-4 dark:border-zinc-700 dark:bg-zinc-900';

/**
 * Documentación en SharePoint: una o varias carpetas (de WPP, de La Caixa…; se pega su dirección o su enlace de
 * «compartir»), si se busca en todo su sitio o solo en ella, subir archivos y los más recientes. Todo por la extensión,
 * con la sesión de cada SharePoint en Chrome.
 */
function SharePointPanel() {
  const extension = useExtension();
  const [sources, setSources] = useSpSources();
  const [adding, setAdding] = useState(false);
  if (!extension) {
    return (
      <aside className={card}>
        <h2 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />Documentación en SharePoint</h2>
        <p className="text-xs text-zinc-500">
          Para buscar en los documentos del equipo (Word, PDF, PowerPoint…) y subir nuevos hace falta la extensión de Chrome «Marea · Lista», con tu
          sesión de SharePoint. Sin ella, el Asistente busca igual en tus tareas, notas, personas y la Lista.
        </p>
        <a href={routeHref({ view: 'lista' })} className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          <Puzzle className="size-3.5" />Instalar la extensión (Lista → Conectar)
        </a>
      </aside>
    );
  }
  const update = (c: SpSource) => setSources(sources.map((x) => (x.id === c.id ? c : x)));
  return (
    <aside className={card}>
      <h2 className="flex items-center gap-2 font-semibold"><BookOpen className="size-4" />Documentación en SharePoint</h2>
      {sources.map((c, i) => (
        <SourceCard key={c.id} source={c} startOpen={i === 0} onChange={update}
          onRemove={() => { if (confirm(`¿Dejar de usar «${c.folderName}»? En SharePoint no se borra nada.`)) setSources(sources.filter((x) => x.id !== c.id)); }} />
      ))}
      {(adding || sources.length === 0) ? (
        <AddSource first={sources.length === 0} onCancel={sources.length ? () => setAdding(false) : undefined}
          onAdd={(c) => { setSources([...sources.filter((x) => x.folderUrl !== c.folderUrl), c]); setAdding(false); }} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          <Plus className="size-3.5" />Añadir otra carpeta (p. ej. de otro SharePoint)
        </button>
      )}
    </aside>
  );
}

function AddSource({ first, onAdd, onCancel }: { first: boolean; onAdd: (c: SpSource) => void; onCancel?: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await extDocs<Omit<SpSource, 'scope' | 'id'>>('resolve', { url: link.trim() });
      onAdd({ ...r, id: crypto.randomUUID(), scope: 'site' });
      track('assistant-sharepoint', 'connect');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="space-y-2 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60">
      <p className="text-xs text-zinc-500">
        {first ? 'Pega la dirección de la carpeta de documentación del equipo' : 'Pega la dirección de otra carpeta'} (la del navegador o su enlace de
        «compartir»). Puede ser de cualquier SharePoint en el que tengas la sesión iniciada en este Chrome (WPP, La Caixa…). Se busca con el buscador
        de SharePoint, sin descargar nada, y cada persona solo ve lo que puede abrir.
      </p>
      <div className="flex gap-2">
        <input autoFocus={!first} value={link} onChange={(e) => { setLink(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && link.trim()) void connect(); }}
          placeholder="https://….sharepoint.com/…" aria-label="Dirección de la carpeta" className={`${inputClass} min-w-0 flex-1 py-1`} />
        <button type="button" disabled={!link.trim() || busy} onClick={() => void connect()}
          className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">{busy ? '…' : 'Usar'}</button>
      </div>
      {error && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
      {onCancel && <button type="button" onClick={onCancel} className="text-xs text-zinc-400 hover:text-zinc-700">Cancelar</button>}
    </div>
  );
}

/** Una carpeta: su sitio, dónde buscar, subir archivos, los últimos y cuántos documentos ha leído el Asistente. */
function SourceCard({ source: config, startOpen, onChange, onRemove }: { source: SpSource; startOpen: boolean; onChange: (c: SpSource) => void; onRemove: () => void }) {
  const toast = useToast();
  const all = useFolderDocs();
  const docs = folderState(all, config.siteUrl, config.folder);
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; url: string; modified: string; size: number; folder: string }[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const host = new URL(config.siteUrl).hostname.replace('.sharepoint.com', '');

  const loadFiles = () => {
    extDocs<{ files: { name: string; url: string; modified: string; size: number; folder: string }[] }>('list', { siteUrl: config.siteUrl, folder: config.folder })
      .then((r) => { setFiles(r.files); setError(null); }, (e: Error) => setError(e.message));
  };
  useEffect(() => { if (open && files === null) loadFiles(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      if (file.size > MAX_UPLOAD) { toast(`«${file.name}» pesa ${kb(file.size)}: desde aquí se suben hasta 15 MB. Súbelo directamente en SharePoint.`); continue; }
      setBusy(`Subiendo ${file.name}…`);
      try {
        const r = await extDocs<{ name: string; url: string }>('upload', { siteUrl: config.siteUrl, folder: config.folder, name: file.name, base64: toBase64(await file.arrayBuffer()) }, 180_000);
        track('assistant-sharepoint', 'upload');
        toast(`«${r.name}» subido a «${config.folderName}».`);
      } catch (e) { toast((e as Error).message); }
    }
    setBusy(null);
    loadFiles();
    void loadFolderDocs(config.siteUrl, config.folder);
  };

  return (
    <div className={`rounded-md border p-2 ${dragging ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950' : 'border-zinc-200 dark:border-zinc-700'}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
      <div className="flex items-start gap-1">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-0.5 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <p className="min-w-0 flex-1 text-xs">
          <a href={config.folderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
            <FolderOpen className="size-3.5" />{config.folderName}<ExternalLink className="size-3 text-zinc-400" />
          </a>
          <span className="block text-zinc-400">{siteName(config)} · {host}</span>
          <span className="block text-[11px] text-zinc-400">
            {docs.loading ? 'Leyendo sus documentos…' : docs.error ? `No se han podido leer: ${docs.error}` : `${docs.docs.length} ${docs.docs.length === 1 ? 'documento leído' : 'documentos leídos'} al momento`}
          </span>
        </p>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          <div className="space-y-0.5 text-xs">
            <span className="text-zinc-500">Buscar con SharePoint en:</span>
            <label className="flex items-center gap-1.5"><input type="radio" checked={config.scope === 'site'} onChange={() => onChange({ ...config, scope: 'site' })} />todo el sitio «{siteName(config)}»</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={config.scope === 'folder'} onChange={() => onChange({ ...config, scope: 'folder' })} />solo esta carpeta</label>
          </div>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
          <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            <Upload className="size-3.5" />Subir a la carpeta
          </button>
          <span className="ml-2 text-[11px] text-zinc-400">o arrastra aquí (hasta 15 MB)</span>
          {busy && <p className="text-xs text-zinc-500">{busy}</p>}
          {error && <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold text-zinc-500">
              Últimos de la carpeta
              <button type="button" onClick={() => { loadFiles(); void loadFolderDocs(config.siteUrl, config.folder); }} aria-label="Volver a cargar"
                className="rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"><RefreshCw className={`size-3 ${docs.loading ? 'animate-spin' : ''}`} /></button>
            </p>
            {files === null && !error && <p className="text-xs text-zinc-400">Cargando…</p>}
            {files && files.length === 0 && <p className="text-xs text-zinc-400">La carpeta está vacía.</p>}
            <ul className="max-h-[30vh] space-y-0.5 overflow-y-auto">
              {files?.map((f) => (
                <li key={f.url}>
                  <a href={f.url} target="_blank" rel="noreferrer" className="block truncate rounded px-1 py-0.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800" title={f.name}>
                    {f.folder && <span className="text-zinc-400">{f.folder}/</span>}{f.name} <span className="text-zinc-400">· {kb(f.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-zinc-400">Los Word y textos se encuentran al momento; los PDF y el resto del sitio, cuando SharePoint los tenga en su buscador (tarda un rato con los nuevos).</p>
          </div>
          <button type="button" onClick={onRemove} className="text-xs text-zinc-400 hover:text-zinc-700">Quitar esta carpeta</button>
        </div>
      )}
    </div>
  );
}

/** De dónde sale la documentación de Confluence que conoce el Asistente (la sube una administradora cada mes). */
function ConfluenceCard() {
  const c = useConfluenceDocs();
  if (!c.loaded && !c.loading) return null;
  return (
    <section className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
      <h2 className="mb-1 flex items-center gap-1.5 font-semibold"><BookOpen className="size-4 text-sky-600" />Documentación de Confluence</h2>
      {c.loading && !c.pages.length ? <p className="text-xs text-zinc-500">Cargando…</p>
        : c.error ? <p className="text-xs text-amber-700 dark:text-amber-300">No se ha podido cargar: {c.error}</p>
          : c.pages.length ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {c.pages.length} páginas{c.updatedAt && `, subidas el ${new Date(c.updatedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`}.
              El Asistente busca en ellas y la IA las usa para responder. Los enlaces abren Confluence, que solo funciona desde la red de CaixaBank.
            </p>
          ) : <p className="text-xs text-zinc-500">Aún no hay documentación subida (la sube una administradora desde Ajustes → Documentación).</p>}
    </section>
  );
}
