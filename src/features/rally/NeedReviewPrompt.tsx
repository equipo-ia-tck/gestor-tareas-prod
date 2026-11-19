import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bug, Search, X } from 'lucide-react';
import type { RallyCc, RallyPick, RallyRef } from '../../domain/rally';
import { commentShape } from '../../domain/rallyComments';
import { rememberAnalyst } from './AnalystPrompt';
import { AddresseeRow, CcRow, MissingPeople, ccOf, initialPeople, missingPeople, type CommentPeopleValue } from './CommentPeople';
import { rallyApi } from './rallyApi';
import { Dialog } from './RallyPickers';
import { box, row, useSearch } from './UserSearch';

/**
 * Lo que se ha rellenado en la ventana o `cancel` si se cierra. Defecto, comentario y motivo son obligatorios; las
 * personas (PO IT y analista) se piden, pero no impiden seguir.
 */
export type NeedReviewAnswer = { defect: RallyPick; text: string; reason: string; owner: RallyRef | null; noOwner: boolean; cc: RallyCc[] } | 'cancel';

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

const SHAPE = commentShape('TS', 'need-review');

/**
 * TS a Need Review: primero el comentario («@PO IT se abre defect <enlace>…» + «CC: @Analista…», con buscador de defectos
 * de Rally que pone el enlace solo; el PO IT se elige a mano, no es el Owner) y después el motivo del bloqueo (de entrada,
 * el ID del defecto; solo va a BlockedReason, no a la discusión). Defecto, comentario y motivo son obligatorios; si falta
 * el PO IT o el analista se avisa, pero se puede seguir. Se hace todo a la vez al final; cerrar en cualquier paso cancela.
 */
export function NeedReviewPrompt() {
  const pending = useSyncExternalStore(subscribe, current);
  const [step, setStep] = useState<'message' | 'reason'>('message');
  const [defect, setDefect] = useState<RallyPick | null>(null);
  const [text, setText] = useState(needReviewText(DEFECT_HOLE));
  const [reason, setReason] = useState('');
  /** PO IT (Para) y CC (analista y más). */
  const [people, setPeople] = useState<CommentPeopleValue>({ to: null, analyst: null, others: [] });
  useEffect(() => {
    setStep('message'); setDefect(null); setText(needReviewText(DEFECT_HOLE)); setReason('');
    setPeople(initialPeople(SHAPE.addressee, SHAPE.analystExpected));
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
  const canNext = !!defect && !!text.trim() && !text.includes(DEFECT_HOLE);
  const missing = missingPeople(SHAPE.addressee, SHAPE.analystExpected, pending.owner, people);
  const accept = () => {
    if (!canNext || !reason.trim()) return;
    if (people.analyst) rememberAnalyst(people.analyst);
    answer({ defect: defect!, text: text.trim(), reason: reason.trim(), owner: people.to, noOwner: !people.to, cc: ccOf(people) });
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
            <div className="space-y-2 rounded-md border border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-800">
              <AddresseeRow addressee={SHAPE.addressee} owner={pending.owner} value={people} onChange={setPeople} />
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="Comentario"
                className="w-full resize-y rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              <CcRow addressee={SHAPE.addressee} analystExpected={SHAPE.analystExpected} value={people} onChange={setPeople} />
              <MissingPeople items={missing} />
            </div>
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={!canNext} onClick={() => setStep('reason')}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Siguiente: motivo del bloqueo</button>
          </div>
          {!canNext && <p className="text-right text-xs text-zinc-400">Hace falta el defecto y el comentario.</p>}
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
