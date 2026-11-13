import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bug, Check, Search, UserRound, X } from 'lucide-react';
import type { RallyPick, RallyRef } from '../../domain/rally';
import { lastAnalyst, rememberAnalyst } from './AnalystPrompt';
import { rallyApi } from './rallyApi';
import { Dialog } from './RallyPickers';

/** Lo que se ha rellenado en la ventana (todo obligatorio) o `cancel` si se cierra. */
export type NeedReviewAnswer = { defect: RallyPick; text: string; analyst: RallyRef; reason: string } | 'cancel';

interface Pending {
  /** FormattedID del TS. */
  id: string;
  name: string;
  owner: string | null;
}

/** Hueco del enlace del defecto en el texto por defecto, hasta que se elige uno. */
export const DEFECT_HOLE = '…….';
export const needReviewText = (link: string) =>
  `se abre defect ${link} por errores encontrado en la validación. Más información sobre los errores en la descripción del DE.`;

type Queued = Pending & { resolve: (a: NeedReviewAnswer) => void };
let queue: Queued[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const current = () => queue[0] ?? null;

export function askNeedReview(p: Pending): Promise<NeedReviewAnswer> {
  return new Promise((resolve) => { queue = [...queue, { ...p, resolve }]; emit(); });
}
function answer(a: NeedReviewAnswer) {
  const [head, ...rest] = queue;
  if (!head) return;
  queue = rest;
  emit();
  head.resolve(a);
}

/**
 * TS a Need Review: primero el comentario («@PO se abre defect <enlace>…» + «Analista: @X», con buscador de defectos de
 * Rally que pone el enlace solo) y después el motivo del bloqueo (de entrada, el ID del defecto; solo va a BlockedReason,
 * no a la discusión). Todo es
 * obligatorio y se hace a la vez al final; cerrar en cualquier paso cancela todo.
 */
export function NeedReviewPrompt() {
  const pending = useSyncExternalStore(subscribe, current);
  const [step, setStep] = useState<'message' | 'reason'>('message');
  const [defect, setDefect] = useState<RallyPick | null>(null);
  const [text, setText] = useState(needReviewText(DEFECT_HOLE));
  const [analyst, setAnalyst] = useState<RallyRef | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setStep('message'); setDefect(null); setText(needReviewText(DEFECT_HOLE)); setAnalyst(lastAnalyst()); setReason('');
  }, [pending]);
  if (!pending) return null;

  const link = (d: RallyPick | null) => (d ? d.url ?? d.id : DEFECT_HOLE);
  const chooseDefect = (d: RallyPick | null) => {
    const before = link(defect);
    setText((t) => (t.includes(before) ? t.replace(before, link(d)) : t));
    // El motivo del bloqueo es el ID del defecto (DE12345), salvo que ya se haya escrito otro a mano.
    setReason((r) => (!r.trim() || r.trim() === defect?.id ? d?.id ?? '' : r));
    setDefect(d);
  };
  const canNext = !!defect && !!analyst && !!text.trim() && !text.includes(DEFECT_HOLE);
  const accept = () => {
    if (!canNext || !reason.trim()) return;
    rememberAnalyst(analyst!);
    answer({ defect: defect!, text: text.trim(), analyst: analyst!, reason: reason.trim() });
  };
  const label = 'mb-0.5 block text-xs font-bold tracking-wide text-zinc-600 uppercase dark:text-zinc-300';

  return (
    <Dialog title={step === 'message' ? 'Need Review · mensaje' : 'Need Review · motivo del bloqueo'} width="max-w-xl" onClose={() => answer('cancel')}>
      <p className="mb-2 text-xs text-zinc-500">{pending.id} · {pending.name}</p>
      {step === 'message' ? (
        <div className="min-h-0 space-y-3 overflow-y-auto">
          <div><span className={label}>Defecto</span><DefectSearch value={defect} onChange={chooseDefect} /></div>
          <div>
            <span className={label}>Comentario en la discusión</span>
            <div className="rounded-md border border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-800">
              {pending.owner
                ? <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">@{pending.owner}</span>
                : <span className="text-xs text-amber-600">No tiene Owner en Rally: no se etiqueta a nadie como PO.</span>}
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="Comentario"
                className="mt-1 w-full resize-y rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              <p className="text-xs"><span className="text-zinc-500">Analista: </span>
                {analyst ? <b className="text-indigo-700 dark:text-indigo-300">@{analyst.name}</b> : <span className="text-zinc-400">(elígelo abajo)</span>}</p>
            </div>
          </div>
          <div><span className={label}>Analista</span><AnalystSearch value={analyst} onChange={setAnalyst} /></div>
          <div className="flex justify-end">
            <button type="button" disabled={!canNext} onClick={() => setStep('reason')}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Siguiente: motivo del bloqueo</button>
          </div>
          {!canNext && <p className="text-right text-xs text-zinc-400">Hace falta el defecto, el analista y el comentario.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">Se marca Blocked en Rally con este motivo (de entrada, el ID del defecto). No se publica en la discusión.</p>
          <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={256} aria-label="Motivo del bloqueo"
            placeholder="¿Por qué está bloqueado?"
            className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setStep('message')}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">Atrás</button>
            <button type="button" disabled={!reason.trim()} onClick={accept}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Aceptar</button>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-400">Si cierras esta ventana no se hace nada: ni se mueve, ni se bloquea, ni se comenta.</p>
    </Dialog>
  );
}

function useSearch<T>(q: string, load: (q: string) => Promise<T[]>, min: number) {
  const [found, setFound] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < min) { setFound(null); return; }
    let live = true;
    setFound(null);
    setError(null);
    const t = setTimeout(() => { load(term).then((r) => live && setFound(r), (e: Error) => live && setError(e.message)); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return { found, error };
}

const box = 'flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 dark:border-zinc-600 dark:bg-zinc-800';
const row = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800';

/** Buscador de defectos de Rally por ID o palabra (en todos los proyectos). */
function DefectSearch({ value, onChange }: { value: RallyPick | null; onChange: (d: RallyPick | null) => void }) {
  const [q, setQ] = useState('');
  const { found, error } = useSearch(q, (term) => rallyApi.pick({ types: ['DE'], q: term, project: '', release: '', page: 1 }).then((r) => r.items), 2);
  if (value) {
    return (
      <div className={`${box} py-1.5`}>
        <Bug className="size-4 text-red-600" /><b>{value.id}</b><span className="flex-1 truncate" title={value.name}>{value.name}</span>
        <button type="button" onClick={() => onChange(null)} aria-label={`Quitar ${value.id}`} className="text-zinc-400 hover:text-zinc-700"><X className="size-4" /></button>
      </div>
    );
  }
  return (
    <>
      <div className={box}>
        <Search className="size-4 text-zinc-400" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar defecto por ID (DE123) o palabra" aria-label="Buscar defecto"
          className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      {q.trim().length >= 2 && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
          {found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
          {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">No hay defectos con eso.</p>}
          {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
          {found?.map((d) => (
            <button key={d.id} type="button" onClick={() => onChange(d)} className={row}>
              <span className="w-20 shrink-0 font-medium">{d.id}</span><span className="flex-1 truncate" title={d.name}>{d.name}</span>
              <span className="w-32 truncate text-xs text-zinc-500">{d.project}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Analista (obligatorio): el último elegido de entrada y búsqueda en Rally. */
function AnalystSearch({ value, onChange }: { value: RallyRef | null; onChange: (u: RallyRef) => void }) {
  const [q, setQ] = useState('');
  const { found, error } = useSearch(q, (term) => rallyApi.searchUsers(term), 2);
  return (
    <>
      <div className={box}>
        <Search className="size-4 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en Rally por nombre, usuario o email" aria-label="Buscar analista"
          className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      {q.trim().length >= 2 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
          {found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
          {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">Nadie con ese nombre.</p>}
          {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
          {found?.map((u) => (
            <button key={u.ref} type="button" onClick={() => { onChange(u); setQ(''); }} className={row}>
              <UserRound className="size-4 text-zinc-400" /><span className="flex-1">{u.name}</span>
              {value?.ref === u.ref && <Check className="size-4 text-indigo-600" />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
