import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Bug, ChevronsLeftRight, GripVertical, ExternalLink, HelpCircle, KanbanSquare, Lightbulb, List, MessageCircle, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { FeedbackDialog } from './FeedbackButton';
import { track } from '../usage/track';
import { useApp } from '../../app/AppContext';
import { StatePill } from '../../components/ui/Badges';
import { useToast } from '../../components/Toast';
import { repo } from '../../data/services';
import { sync, useSync } from '../../data/sync';
import {
  areaLabel, browserSummary, FEEDBACK_AREAS, FEEDBACK_IMPACTS, FEEDBACK_KINDS, FEEDBACK_STATUSES, isOpenFeedback, feedbackPriority, feedbackTaskTitle, impactLabel, kindLabel, moveFeedback, sortFeedback,
  type Feedback, type FeedbackImpact, type FeedbackKind, type FeedbackStatus,
} from '../../domain/feedback';
import { stateOf } from '../../domain/workflows';
import { tint } from '../../domain/colors';
import { fold } from '../../domain/text';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useWideLayout } from '../../app/Layout';
import { ViewHeader } from '../views/ViewHeader';
import { FeedbackDashboard } from './FeedbackDashboard';

const KIND_ICON = { bug: Bug, improvement: Sparkles, idea: Lightbulb, question: HelpCircle, other: MessageCircle } as const;
const KIND_COLOR: Record<FeedbackKind, string> = {
  bug: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  improvement: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  idea: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  question: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  other: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};
const STATUS_COLOR: Record<FeedbackStatus, string> = {
  new: 'border-indigo-300 text-indigo-700 dark:border-indigo-700 dark:text-indigo-300',
  doing: 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300',
  blocked: 'border-red-300 text-red-700 dark:border-red-700 dark:text-red-300',
  done: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300',
  dismissed: 'border-zinc-300 text-zinc-500 dark:border-zinc-600',
};

const IMPACT_COLOR: Record<FeedbackImpact, string> = {
  blocking: 'text-red-600 dark:text-red-400',
  annoying: 'text-amber-600 dark:text-amber-400',
  minor: 'text-zinc-500',
};

const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Más → Feedback: todo lo que envían los usuarios con el botón flotante. Solo administradores. Vista de lista, tablero y panel. */
export function FeedbackView() {
  const { isAdmin } = useSync();
  const toast = useToast();
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = usePersistentState<FeedbackViewMode>('feedback-view', 'list');
  const [kind, setKind] = useState<FeedbackKind | 'all'>('all');
  const [status, setStatus] = useState<FeedbackStatus | 'open' | 'all'>('all');
  const [area, setArea] = useState('all');
  const [impact, setImpact] = useState<FeedbackImpact | 'all'>('all');
  const [author, setAuthor] = useState('all');
  const [query, setQuery] = useState('');
  // Los usuarios ven aquí «Mis solicitudes» a lo ancho normal.
  useWideLayout(isAdmin);

  const load = useCallback(async () => {
    setError('');
    try { setItems(await sync().adminFeedback()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  if (!isAdmin) return <MyFeedback />;

  const replace = (f: Feedback) => setItems((list) => list?.map((x) => (x.id === f.id ? f : x)) ?? null);
  const update = async (id: string, patch: { status?: FeedbackStatus; taskId?: string }) => {
    // Al momento en pantalla (arrastrar en el tablero) y después lo que devuelve Supabase; si falla, se vuelve atrás.
    const before = items?.find((x) => x.id === id);
    if (before && patch.status) replace({ ...before, status: patch.status });
    try { replace(await sync().updateFeedback(id, patch)); } catch (e) { if (before) replace(before); toast(e instanceof Error ? e.message : String(e)); }
  };

  // Orden de prioridad (migración 017): lo sin ordenar arriba y después la posición que ponen los administradores.
  const all = sortFeedback(items ?? []);
  /** Mueve `id` antes o después de `target` (en la lista entera) y guarda el orden; si falla, vuelve atrás. */
  const reorder = async (id: string, target: string, place: 'before' | 'after') => {
    const ids = moveFeedback(all, id, target, place);
    const before = items;
    const pos = new Map(ids.map((x, i) => [x, i + 1]));
    setItems((list) => list?.map((f) => ({ ...f, rank: pos.get(f.id) ?? f.rank ?? null })) ?? null);
    try { await sync().orderFeedback(ids); } catch (e) { setItems(before); toast(e instanceof Error ? e.message : String(e)); }
  };
  const words = fold(query).split(/\s+/).filter(Boolean);
  // Los mismos filtros en las tres vistas. En el tablero, el estado deja solo sus columnas.
  const filtered = all.filter((f) => (kind === 'all' || f.kind === kind) && (area === 'all' || f.area === area)
    && (impact === 'all' || f.impact === impact) && (author === 'all' || (f.authorName || f.authorLogin) === author)
    && words.every((w) => fold(`${f.title} ${f.body} ${f.authorName}`).includes(w)));
  const count = (s: FeedbackStatus | 'open') => filtered.filter((f) => (s === 'open' ? isOpenFeedback(f) : f.status === s)).length;
  const shown = filtered.filter((f) => status === 'all' || (status === 'open' ? isOpenFeedback(f) : f.status === status));
  const authors = [...new Set(all.map((f) => f.authorName || f.authorLogin).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const filtering = status !== 'all' || kind !== 'all' || area !== 'all' || impact !== 'all' || author !== 'all' || !!query;
  const clear = () => { setStatus('all'); setKind('all'); setArea('all'); setImpact('all'); setAuthor('all'); setQuery(''); };

  const chip = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-xs ${on
    ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
    : 'border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800'}`;
  const select = 'rounded-full border border-zinc-300 bg-transparent px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-600 dark:text-zinc-300';

  return (
    <>
      <ViewHeader title="Feedback" subtitle="Mejoras, cosas rotas y comentarios que envían los usuarios con el botón «Feedback»"
        actions={<div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
            {VIEWS.map(({ id, label, Icon }) => (
              <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${view === id ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
                <Icon className="size-4" />{label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void load()} title="Actualizar"
            className="flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
            <RefreshCw className="size-3.5" />Actualizar
          </button>
        </div>} />

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {!items && !error && <p className="text-sm text-zinc-400">Cargando…</p>}

      {items && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {([['open', 'Abiertos'], ...FEEDBACK_STATUSES.map((s) => [s.id, s.label]), ['all', 'Todos']] as [FeedbackStatus | 'open' | 'all', string][]).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setStatus(id)} className={chip(status === id)}>
                {label}{id !== 'all' ? ` · ${count(id)}` : ''}
              </button>
            ))}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setKind('all')} className={chip(kind === 'all')}>Todos los tipos</button>
            {FEEDBACK_KINDS.map((k) => (
              <button key={k.id} type="button" onClick={() => setKind(k.id)} className={chip(kind === k.id)}>{k.label}</button>
            ))}
            {all.some((f) => f.kind === 'other') && <button type="button" onClick={() => setKind('other')} className={chip(kind === 'other')}>Otro</button>}
            <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Parte de la web" className={`ml-1 ${select}`}>
              <option value="all">Todas las partes de la web</option>
              {FEEDBACK_AREAS.filter((a) => all.some((f) => f.area === a.id)).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <select value={impact} onChange={(e) => setImpact(e.target.value as FeedbackImpact | 'all')} aria-label="Impacto" className={select}>
              <option value="all">Cualquier impacto</option>
              {FEEDBACK_IMPACTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
            <select value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Quién lo envía" className={select}>
              <option value="all">Cualquier persona</option>
              {authors.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar…" aria-label="Filtrar por texto"
              className="w-36 rounded-full border border-zinc-300 bg-transparent px-2.5 py-0.5 text-xs dark:border-zinc-600" />
            {filtering && <button type="button" onClick={clear} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Quitar filtros</button>}
          </div>

          {view === 'list' && (
            <>
              {!shown.length && <p className="text-sm text-zinc-400">No hay feedback {status === 'open' && !filtering ? 'abierto' : 'con este filtro'}.</p>}
              {shown.length > 1 && <p className="mb-2 text-xs text-zinc-400">Ordénalos por prioridad: arrastra por el asa o usa las flechas. Lo de arriba es lo primero que hay que hacer; lo que aún no tiene número está sin ordenar.</p>}
              <ul className="space-y-3">
                {shown.map((f, i) => (
                  <SortableRow key={f.id} f={f} position={f.rank != null ? i + 1 : null}
                    onMove={(id, place) => void reorder(id, f.id, place)}
                    onUp={i > 0 ? () => void reorder(f.id, shown[i - 1].id, 'before') : undefined}
                    onDown={i < shown.length - 1 ? () => void reorder(f.id, shown[i + 1].id, 'after') : undefined}>
                    <FeedbackCard f={f} onUpdate={(patch) => update(f.id, patch)} />
                  </SortableRow>
                ))}
              </ul>
            </>
          )}
          {view === 'board' && <FeedbackBoard items={shown} onUpdate={update} onReorder={reorder}
            columns={FEEDBACK_STATUSES.filter((c) => status === 'all' || (status === 'open' ? isOpenFeedback({ status: c.id } as Feedback) : c.id === status))} />}
          {view === 'dashboard' && (
            shown.length ? (
              <FeedbackDashboard items={shown}
                onStatus={(st) => { setStatus(st); setView('list'); }}
                onKind={(k) => { setKind(k); setView('list'); }}
                onArea={(a) => { setArea(a); setView('list'); }} />
            ) : <p className="text-sm text-zinc-400">No hay feedback con este filtro.</p>
          )}
        </>
      )}
    </>
  );
}

type FeedbackViewMode = 'list' | 'board' | 'dashboard';
const VIEWS: { id: FeedbackViewMode; label: string; Icon: typeof List }[] = [
  { id: 'list', label: 'Lista', Icon: List },
  { id: 'board', label: 'Tablero', Icon: KanbanSquare },
  { id: 'dashboard', label: 'Panel', Icon: BarChart3 },
];

const FEEDBACK_MIME = 'application/x-gestor-feedback';
const COLUMN_COLOR: Record<FeedbackStatus, string> = { new: '#2E6BE6', doing: '#f59e0b', blocked: '#ef4444', done: '#22c55e', dismissed: '#a1a1aa' };

/** Tablero del feedback: una columna por estado; arrastrar una tarjeta a otra columna le cambia el estado. */
function FeedbackBoard({ items, columns, onUpdate, onReorder }: {
  items: Feedback[];
  columns: typeof FEEDBACK_STATUSES;
  onUpdate: (id: string, patch: { status?: FeedbackStatus; taskId?: string }) => Promise<void>;
  onReorder: (id: string, target: string, place: 'before' | 'after') => Promise<void>;
}) {
  const [over, setOver] = useState<FeedbackStatus | null>(null);
  // Columnas plegadas, como en el Tablero de tareas (se recuerdan en el navegador).
  const [collapsed, setCollapsed] = usePersistentState<FeedbackStatus[]>('feedback-board-collapsed', []);
  const toggle = (id: FeedbackStatus) => setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);
  return (
    <div className="-mx-6 flex max-h-[calc(100dvh-13rem)] min-h-80 gap-3 overflow-x-auto px-6 pb-3">
      {columns.map((col) => {
        const list = items.filter((f) => f.status === col.id);
        const folded = collapsed.includes(col.id);
        return (
          <section key={col.id} aria-label={folded ? `${col.label} (plegada)` : col.label}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(FEEDBACK_MIME)) { e.preventDefault(); setOver(col.id); } }}
            onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(FEEDBACK_MIME);
              setOver(null);
              if (!id) return;
              e.preventDefault();
              if (items.find((f) => f.id === id)?.status !== col.id) void onUpdate(id, { status: col.id });
            }}
            className={`flex min-h-0 flex-col rounded-xl transition-colors ${folded ? 'w-10 shrink-0 items-center py-2' : 'min-w-48 flex-1 basis-0 p-2'} ${over === col.id ? 'ring-2 ring-indigo-400' : ''}`}
            style={{ background: tint(COLUMN_COLOR[col.id], over === col.id ? 0.22 : 0.1) }}>
            {folded ? (
              <button type="button" onClick={() => toggle(col.id)} title={`Desplegar ${col.label}`}
                className="flex flex-1 flex-col items-center gap-2 rounded px-1 hover:bg-black/5 dark:hover:bg-white/5">
                <ChevronsLeftRight className="size-3.5 text-zinc-500" />
                <span className="size-2.5 rounded-full" style={{ background: COLUMN_COLOR[col.id] }} />
                <span className="text-xs text-zinc-500">{list.length}</span>
                <span className="text-sm font-semibold [writing-mode:vertical-rl]">{col.label}</span>
              </button>
            ) : <>
            <header className="mb-2 flex items-center gap-2 px-1">
              <span className="size-2.5 rounded-full" style={{ background: COLUMN_COLOR[col.id] }} />
              <h3 className="text-sm font-semibold">{col.label}</h3>
              <span className="text-xs text-zinc-500">{list.length}</span>
              <button type="button" onClick={() => toggle(col.id)} title={`Plegar ${col.label}`} aria-label={`Plegar ${col.label}`}
                className="ml-auto rounded p-0.5 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/5 dark:hover:text-zinc-200">
                <ChevronsLeftRight className="size-3.5" />
              </button>
            </header>
            <ul className="-mx-1 flex min-h-8 flex-1 flex-col gap-2 overflow-y-auto px-1 pb-1">
              {list.map((f, i) => <BoardCard key={f.id} f={f} position={f.rank != null ? i + 1 : null} onUpdate={(patch) => onUpdate(f.id, patch)}
                onDropHere={(id, place) => {
                  setOver(null);
                  // Soltar encima de una tarjeta: se coloca antes o después de ella (y, si viene de otra columna, cambia de estado).
                  if (items.find((x) => x.id === id)?.status !== col.id) void onUpdate(id, { status: col.id });
                  void onReorder(id, f.id, place);
                }} />)}
            </ul>
            </>}
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({ f, position, onUpdate, onDropHere }: {
  f: Feedback;
  /** Posición dentro de su columna (null = sin ordenar). */
  position: number | null;
  onUpdate: (patch: { status?: FeedbackStatus; taskId?: string }) => Promise<void>;
  onDropHere: (id: string, place: 'before' | 'after') => void;
}) {
  const [open, setOpen] = useState(false);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const Icon = KIND_ICON[f.kind];
  return (
    // Desplegada no se arrastra: así se puede escribir y seleccionar texto en la respuesta.
    <li draggable={!open} onDragStart={(e) => { e.dataTransfer.setData(FEEDBACK_MIME, f.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FEEDBACK_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setDrop(placeOf(e));
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(FEEDBACK_MIME);
        setDrop(null);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        if (id !== f.id) onDropHere(id, placeOf(e));
      }}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button, select, textarea, input')) setOpen(!open); }}
      style={drop ? { boxShadow: `0 ${drop === 'before' ? '-3px' : '3px'} 0 0 rgb(99 102 241)` } : undefined}
      className="shrink-0 cursor-grab rounded-lg border border-zinc-200 bg-white p-2.5 text-sm shadow-sm [overflow-wrap:anywhere] hover:shadow-md active:cursor-grabbing dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px font-medium ${KIND_COLOR[f.kind]}`}><Icon className="size-3" />{kindLabel(f.kind)}</span>
        {f.area && <span className="rounded-full bg-zinc-100 px-1.5 py-px text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{areaLabel(f.area)}</span>}
        {f.impact && <span className={`font-medium ${IMPACT_COLOR[f.impact]}`}>{impactLabel(f.impact)}</span>}
      </div>
      <p className="font-medium leading-snug">{position != null && <span className="mr-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400">#{position}</span>}{f.title || f.body.split('\n')[0]}</p>
      {f.body && f.title && <p className={`mt-1 text-xs whitespace-pre-wrap text-zinc-600 dark:text-zinc-300 ${open ? '' : 'line-clamp-3'}`}>{f.body}</p>}
      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400">
        <span className="truncate font-medium text-zinc-600 dark:text-zinc-300">{f.authorName || f.authorLogin || 'Cuenta eliminada'}</span>· {when(f.createdAt)}
      </p>
      {open && (
        <div className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <FeedbackCard f={f} onUpdate={onUpdate} bare />
        </div>
      )}
    </li>
  );
}

/** Feedback completo (lista). `bare`: dentro de una tarjeta del tablero, sin marco ni la frase y el detalle (ya los enseña la tarjeta). */
function FeedbackCard({ f, onUpdate, bare = false }: { f: Feedback; onUpdate: (patch: { status?: FeedbackStatus; taskId?: string }) => Promise<void>; bare?: boolean }) {
  const { tasks, itemTypes, editTask } = useApp();
  const Icon = KIND_ICON[f.kind];
  const task = f.taskId ? tasks.find((t) => t.id === f.taskId) : undefined;

  const toTask = async () => {
    let id = '';
    await repo.batch('Tarea creada desde el feedback', async () => {
      const t = await repo.createTask({
        title: feedbackTaskTitle(f),
        tags: ['feedback'],
        priority: feedbackPriority(f),
        notes: [f.body, [
          `Feedback de ${f.authorName || f.authorLogin} (${when(f.createdAt)}) · ${kindLabel(f.kind)}${f.area ? ` · ${areaLabel(f.area)}` : ''}${f.impact ? ` · ${impactLabel(f.impact)}` : ''}`,
          f.page ? `Pantalla: ${f.page}` : '', f.userAgent ? `Navegador: ${browserSummary(f.userAgent)}${f.screen ? ` · ${f.screen}` : ''}` : '',
        ].filter(Boolean).join('\n')].filter(Boolean).join('\n\n'),
      });
      id = t.id;
    });
    if (id) await onUpdate({ taskId: id, status: f.status === 'new' ? 'doing' : undefined });
  };

  return (
    <Wrapper bare={bare} className={`rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${f.status === 'done' || f.status === 'dismissed' ? 'opacity-70' : ''}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${KIND_COLOR[f.kind]}`}><Icon className="size-3" />{kindLabel(f.kind)}</span>
        {f.area && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{areaLabel(f.area)}</span>}
        {f.impact && <span className={`font-medium ${IMPACT_COLOR[f.impact]}`}>{impactLabel(f.impact)}</span>}
        <span className="font-medium text-zinc-700 dark:text-zinc-200" title={f.authorLogin}>{f.authorName || f.authorLogin || 'Cuenta eliminada'}</span>
        <span className="text-zinc-400">{when(f.createdAt)}</span>
        {f.page && <a href={f.page} className="inline-flex items-center gap-0.5 text-zinc-400 hover:underline" title="Abrir la pantalla desde la que se envió">{f.page}<ExternalLink className="size-3" /></a>}
        {f.userAgent && <span className="text-zinc-400" title={f.userAgent}>{browserSummary(f.userAgent)}{f.screen ? ` · ${f.screen}` : ''}</span>}
        <span className="flex-1" />
        <select value={f.status} onChange={(e) => void onUpdate({ status: e.target.value as FeedbackStatus })} aria-label="Estado"
          className={`rounded-md border bg-transparent px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOR[f.status]}`}>
          {FEEDBACK_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {!bare && f.title && <p className="text-sm font-semibold">{f.title}</p>}
      {!bare && f.body && <p className={`text-sm whitespace-pre-wrap ${f.title ? 'mt-1 text-zinc-600 dark:text-zinc-300' : ''}`}>{f.body}</p>}
      <ReplyBox f={f} />
      <div className="mt-2 text-xs">
        {task ? (
          <button type="button" onClick={() => editTask(task)} className="inline-flex items-center gap-1.5 text-emerald-700 hover:underline dark:text-emerald-400">
            ✓ Tarea: {task.title} <StatePill state={stateOf(itemTypes, task)} />
          </button>
        ) : f.taskId ? (
          <span className="text-zinc-400">La tarea que se creó ya no existe (o es de otro administrador).</span>
        ) : (
          <button type="button" onClick={() => void toTask()}
            className="rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900/60">→ Tarea</button>
        )}
      </div>
    </Wrapper>
  );
}

const Wrapper = ({ bare, className, children }: { bare: boolean; className: string; children: ReactNode }) => (bare ? <div>{children}</div> : <div className={className}>{children}</div>);

/** Mitad de arriba = antes; mitad de abajo = después. */
const placeOf = (e: React.DragEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' as const : 'after' as const;
};

/**
 * Fila de la Lista que se ordena: asa para arrastrar (solo el asa, así se puede escribir la respuesta), número de
 * prioridad y flechas para subir o bajar una posición.
 */
function SortableRow({ f, position, onMove, onUp, onDown, children }: {
  f: Feedback;
  position: number | null;
  onMove: (id: string, place: 'before' | 'after') => void;
  onUp?: () => void;
  onDown?: () => void;
  children: ReactNode;
}) {
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const arrow = 'rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:invisible dark:hover:bg-zinc-800 dark:hover:text-zinc-200';
  return (
    <li className="relative flex gap-1.5"
      onDragOver={(e) => { if (e.dataTransfer.types.includes(FEEDBACK_MIME)) { e.preventDefault(); setDrop(placeOf(e)); } }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(FEEDBACK_MIME);
        setDrop(null);
        if (!id) return;
        e.preventDefault();
        if (id !== f.id) onMove(id, placeOf(e));
      }}>
      {drop && <span className={`pointer-events-none absolute inset-x-0 h-0.5 rounded bg-indigo-500 ${drop === 'before' ? '-top-2' : '-bottom-2'}`} />}
      <div className="flex w-7 shrink-0 flex-col items-center gap-0.5 pt-2">
        <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400" title={position ? 'Posición en el orden de prioridad' : 'Sin ordenar'}>{position ? `#${position}` : '·'}</span>
        <button type="button" onClick={onUp} disabled={!onUp} title="Subir" aria-label="Subir" className={arrow}><ArrowUp className="size-3.5" /></button>
        <span draggable title="Arrastrar para ordenar" aria-label="Arrastrar para ordenar"
          onDragStart={(e) => {
            e.dataTransfer.setData(FEEDBACK_MIME, f.id);
            e.dataTransfer.effectAllowed = 'move';
            const row = (e.currentTarget as HTMLElement).closest('li');
            if (row) e.dataTransfer.setDragImage(row, 20, 20);
          }}
          className="cursor-grab rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 active:cursor-grabbing dark:hover:bg-zinc-800"><GripVertical className="size-4" /></span>
        <button type="button" onClick={onDown} disabled={!onDown} title="Bajar" aria-label="Bajar" className={arrow}><ArrowDown className="size-3.5" /></button>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** Respuesta del administrador: la ve quien lo envió en «Mis solicitudes» (migración 016). */
function ReplyBox({ f }: { f: Feedback }) {
  const toast = useToast();
  const [text, setText] = useState(f.reply ?? '');
  const [saved, setSaved] = useState({ reply: f.reply ?? '', at: f.replyAt ?? null });
  const [saving, setSaving] = useState(false);
  const changed = text.trim() !== saved.reply.trim();
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    try {
      const r = await sync().replyFeedback(f.id, text);
      setSaved({ reply: r.reply ?? '', at: r.replyAt ?? null });
      setText(r.reply ?? '');
      toast(r.reply ? `Respuesta enviada a ${f.authorName || 'quien lo envió'}` : 'Respuesta quitada');
    } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };
  return (
    <div className="mt-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void save(); } }}
        placeholder={`Respuesta para ${f.authorName || 'quien lo envió'} (la ve en «Mis solicitudes»)`}
        className="w-full resize-y rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-zinc-700" />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <button type="button" onClick={() => void save()} disabled={!changed || saving}
          className="rounded bg-indigo-600 px-2 py-0.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          {saving ? 'Enviando…' : text.trim() || !saved.reply ? 'Enviar respuesta' : 'Quitar respuesta'}
        </button>
        {changed && !saving && <span className="text-amber-600 dark:text-amber-400">Sin enviar</span>}
        {!changed && saved.reply && <span className="text-emerald-700 dark:text-emerald-400">✓ Enviada{saved.at ? ` el ${when(saved.at)}` : ''}: la ve en «Mis solicitudes»</span>}
      </div>
    </div>
  );
}

/** «Mis solicitudes»: lo que ha enviado la persona con el botón «Feedback» y en qué estado está, con la respuesta si la hay. */
export function MyFeedback() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState('');
  const [show, setShow] = useState<'open' | 'all'>('all');
  /** Solicitud que se está editando (solo las que siguen en Nuevo, migración 019). */
  const [editing, setEditing] = useState<Feedback | null>(null);
  const load = useCallback(async () => {
    setError('');
    try { setItems(await sync().myFeedback()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const all = items ?? [];
  const list = show === 'open' ? all.filter(isOpenFeedback) : all;
  const open = all.filter(isOpenFeedback).length;
  return (
    <>
      <ViewHeader title="Mis solicitudes" subtitle="Lo que has enviado con el botón «Feedback» y en qué estado está" />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {([['all', `Todas (${all.length})`], ['open', `Abiertas (${open})`]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setShow(id)}
              className={`rounded-md px-2.5 py-0.5 ${show === id ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500'}`}>{label}</button>
          ))}
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          <RefreshCw className="size-3.5" />Actualizar
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {items && !list.length && !error && (
        <p className="text-sm text-zinc-500">
          {all.length ? 'No tienes solicitudes abiertas.' : 'Aún no has enviado nada. Usa el botón «Feedback» de abajo a la derecha para contar qué no funciona, proponer mejoras o preguntar dudas.'}
        </p>
      )}
      <ul className="space-y-2">
        {list.map((f) => {
          const Icon = KIND_ICON[f.kind];
          const status = FEEDBACK_STATUSES.find((x) => x.id === f.status)?.label ?? f.status;
          const editable = f.status === 'new';
          return (
            <li key={f.id} onClick={(e) => { if (editable && !(e.target as HTMLElement).closest('a, button')) setEditing(f); }}
              title={editable ? 'Haz clic para editarla (se puede mientras esté en «Nuevo»)' : undefined}
              className={`rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${f.status === 'dismissed' ? 'opacity-70' : ''} ${editable ? 'cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/40 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20' : ''}`}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${KIND_COLOR[f.kind]}`}><Icon className="size-3" />{kindLabel(f.kind)}</span>
                {f.area && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{areaLabel(f.area)}</span>}
                {f.impact && <span className={`font-medium ${IMPACT_COLOR[f.impact]}`}>{impactLabel(f.impact)}</span>}
                <span className="text-zinc-400">Enviada el {when(f.createdAt)}</span>
                <span className="flex-1" />
                {editable && (
                  <button type="button" onClick={() => setEditing(f)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-950">
                    <Pencil className="size-3" />Editar
                  </button>
                )}
                <span className={`rounded-md border px-1.5 py-0.5 font-medium ${STATUS_COLOR[f.status]}`}>{status}</span>
              </div>
              {f.title && <p className="text-sm font-semibold">{f.title}</p>}
              {f.body && <p className={`text-sm whitespace-pre-wrap ${f.title ? 'mt-1 text-zinc-600 dark:text-zinc-300' : ''}`}>{f.body}</p>}
              {f.reply && (
                <div className="mt-2 rounded-md border-l-4 border-indigo-400 bg-indigo-50/60 px-3 py-1.5 text-sm dark:bg-indigo-950/30">
                  <p className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300">Respuesta{f.replyAt ? ` · ${when(f.replyAt)}` : ''}</p>
                  <p className="whitespace-pre-wrap">{f.reply}</p>
                </div>
              )}
              {f.updatedAt !== f.createdAt && f.status !== 'new' && <p className="mt-1.5 text-[11px] text-zinc-400">Último cambio: {when(f.updatedAt)}</p>}
            </li>
          );
        })}
      </ul>
      {editing && (
        <FeedbackDialog taskOpen={false} editing={editing} onClose={() => setEditing(null)}
          onSaved={(saved) => { setItems((list) => (list ?? []).map((x) => (x.id === saved.id ? { ...x, ...saved } : x))); setEditing(null); track('feedback-edit'); }} />
      )}
    </>
  );
}
