import { useCallback, useEffect, useState } from 'react';
import { Bug, ExternalLink, HelpCircle, Lightbulb, MessageCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { StatePill } from '../../components/ui/Badges';
import { useToast } from '../../components/Toast';
import { repo } from '../../data/services';
import { sync, useSync } from '../../data/sync';
import {
  areaLabel, browserSummary, FEEDBACK_AREAS, FEEDBACK_KINDS, FEEDBACK_STATUSES, feedbackPriority, feedbackTaskTitle, impactLabel, kindLabel,
  type Feedback, type FeedbackImpact, type FeedbackKind, type FeedbackStatus,
} from '../../domain/feedback';
import { stateOf } from '../../domain/workflows';
import { ViewHeader } from '../views/ViewHeader';

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
  done: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300',
  dismissed: 'border-zinc-300 text-zinc-500 dark:border-zinc-600',
};

const IMPACT_COLOR: Record<FeedbackImpact, string> = {
  blocking: 'text-red-600 dark:text-red-400',
  annoying: 'text-amber-600 dark:text-amber-400',
  minor: 'text-zinc-500',
};

const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Más → Feedback: todo lo que envían los usuarios con el botón flotante. Solo administradores. */
export function FeedbackView() {
  const { isAdmin } = useSync();
  const toast = useToast();
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<FeedbackKind | 'all'>('all');
  const [status, setStatus] = useState<FeedbackStatus | 'open' | 'all'>('open');
  const [area, setArea] = useState('all');

  const load = useCallback(async () => {
    setError('');
    try { setItems(await sync().adminFeedback()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  if (!isAdmin) return <><ViewHeader title="Feedback" /><p className="text-sm text-zinc-500">Solo los administradores ven el feedback. Para enviar el tuyo, usa el botón «Feedback» de abajo a la derecha.</p></>;

  const replace = (f: Feedback) => setItems((list) => list?.map((x) => (x.id === f.id ? f : x)) ?? null);
  const update = async (id: string, patch: { status?: FeedbackStatus; taskId?: string }) => {
    try { replace(await sync().updateFeedback(id, patch)); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };

  const all = items ?? [];
  const count = (s: FeedbackStatus | 'open') => all.filter((f) => (s === 'open' ? f.status === 'new' || f.status === 'doing' : f.status === s)).length;
  const shown = all.filter((f) => (kind === 'all' || f.kind === kind) && (area === 'all' || f.area === area)
    && (status === 'all' || (status === 'open' ? f.status === 'new' || f.status === 'doing' : f.status === status)));

  const chip = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-xs ${on
    ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
    : 'border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800'}`;

  return (
    <>
      <ViewHeader title="Feedback" subtitle="Mejoras, cosas rotas y comentarios que envían los usuarios con el botón «Feedback»"
        actions={<button type="button" onClick={() => void load()} title="Actualizar"
          className="flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
          <RefreshCw className="size-3.5" />Actualizar
        </button>} />

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {([['open', 'Abiertos'], ...FEEDBACK_STATUSES.map((s) => [s.id, s.label]), ['all', 'Todos']] as [FeedbackStatus | 'open' | 'all', string][]).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setStatus(id)} className={chip(status === id)}>
            {label}{id !== 'all' && items ? ` · ${count(id)}` : ''}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setKind('all')} className={chip(kind === 'all')}>Todos los tipos</button>
        {FEEDBACK_KINDS.map((k) => (
          <button key={k.id} type="button" onClick={() => setKind(k.id)} className={chip(kind === k.id)}>{k.label}</button>
        ))}
        {all.some((f) => f.kind === 'other') && <button type="button" onClick={() => setKind('other')} className={chip(kind === 'other')}>Otro</button>}
        <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Parte de la web"
          className="ml-1 rounded-full border border-zinc-300 bg-transparent px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-600 dark:text-zinc-300">
          <option value="all">Todas las partes de la web</option>
          {FEEDBACK_AREAS.filter((a) => all.some((f) => f.area === a.id)).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {!items && !error && <p className="text-sm text-zinc-400">Cargando…</p>}
      {items && !shown.length && <p className="text-sm text-zinc-400">No hay feedback {status === 'open' ? 'abierto' : 'con este filtro'}.</p>}
      <ul className="space-y-3">
        {shown.map((f) => <FeedbackCard key={f.id} f={f} onUpdate={(patch) => update(f.id, patch)} />)}
      </ul>
    </>
  );
}

function FeedbackCard({ f, onUpdate }: { f: Feedback; onUpdate: (patch: { status?: FeedbackStatus; taskId?: string }) => Promise<void> }) {
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
    <li className={`rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 ${f.status === 'done' || f.status === 'dismissed' ? 'opacity-70' : ''}`}>
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
      {f.title && <p className="text-sm font-semibold">{f.title}</p>}
      {f.body && <p className={`text-sm whitespace-pre-wrap ${f.title ? 'mt-1 text-zinc-600 dark:text-zinc-300' : ''}`}>{f.body}</p>}
      <div className="mt-2 text-xs">
        {task ? (
          <button type="button" onClick={() => editTask(task)} className="inline-flex items-center gap-1.5 text-emerald-700 hover:underline dark:text-emerald-400">
            ✓ Tarea: {task.title} <StatePill state={stateOf(itemTypes, task)} />
          </button>
        ) : f.taskId ? (
          <span className="text-zinc-400">La tarea que se creó ya no existe (o es de otro administrador).</span>
        ) : (
          <button type="button" onClick={() => void toTask()}
            className="rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300">→ Tarea</button>
        )}
      </div>
    </li>
  );
}
