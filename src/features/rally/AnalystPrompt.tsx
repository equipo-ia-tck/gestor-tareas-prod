import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Pencil, Search, UserRound } from 'lucide-react';
import type { RallyRef } from '../../domain/rally';
import { rallyApi } from './rallyApi';
import { Dialog } from './RallyPickers';
import { OwnerMention } from './UserSearch';

/** Respuesta de la ventana: con o sin analista, o `cancel` (la cruz, Esc o clic fuera) para no mover. */
/** `owner`: persona mencionada en lugar del Owner (null = el Owner del elemento). */
export type AnalystAnswer = { analyst: RallyRef | null; text: string; owner: RallyRef | null } | 'cancel';

/** Movimiento a la espera de saber si se marca analista (todavía no se ha hecho en Rally). */
export interface PendingComment {
  /** FormattedID: "US1764574". */
  id: string;
  name: string;
  text: string;
  /** Owner en Rally (el PO), que se menciona siempre. */
  owner: string | null;
  /** Qué pasa si se cierra la ventana (por defecto, que no se mueve). */
  closeHint?: string;
}

type Queued = PendingComment & { resolve: (a: AnalystAnswer) => void };

// Cola en memoria: si se mueven varias a la vez, se pregunta de una en una.
let queue: Queued[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function askAnalyst(c: PendingComment): Promise<AnalystAnswer> {
  return new Promise((resolve) => {
    queue = [...queue, { ...c, resolve }];
    emit();
  });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const current = () => queue[0] ?? null;
function answer(a: AnalystAnswer) {
  const [head, ...rest] = queue;
  if (!head) return;
  queue = rest;
  emit();
  head.resolve(a);
}

const LAST_KEY = 'gestor-tareas:rally-last-analyst';
export function lastAnalyst(): RallyRef | null {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as RallyRef | null; } catch { return null; }
}
export function rememberAnalyst(u: RallyRef) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(u)); } catch { /* sin almacenamiento */ }
}

/**
 * Antes de mover un elemento en Rally: «¿Quieres marcar analista?». Con «Sí» se busca a la persona en Rally y «Aceptar»
 * mueve y publica el comentario con el PO y el analista; «No quiero marcar analista» mueve y lo publica solo con el PO.
 * Cerrar (la cruz, Esc o clic fuera) cancela: no se mueve en Rally y la tarea vuelve a su estado en el gestor.
 */
export function AnalystPrompt() {
  const pending = useSyncExternalStore(subscribe, current);
  const [step, setStep] = useState<'ask' | 'pick'>('ask');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState<RallyRef | null>(null);
  useEffect(() => { setStep('ask'); setText(pending?.text ?? ''); setEditing(false); setOwner(null); }, [pending]);
  if (!pending) return null;

  const finalText = text.trim() || pending.text;
  const publish = (analyst: RallyRef | null) => {
    if (analyst) rememberAnalyst(analyst);
    answer({ analyst, text: finalText, owner });
  };
  const stopEditing = () => { setText(finalText); setEditing(false); };

  return (
    <Dialog title={step === 'ask' ? '¿Quieres marcar analista?' : 'Analista'} width="max-w-md" onClose={() => answer('cancel')}
      onEscape={editing ? stopEditing : undefined}>
      <div className="mb-3 rounded-md bg-zinc-50 p-2 text-sm dark:bg-zinc-800">
        <p className="text-xs text-zinc-500">{pending.id} · {pending.name}</p>
        {editing ? (
          <div className="mt-1">
            <OwnerMention owner={pending.owner} value={owner} onChange={setOwner} />
            <div className="flex items-start gap-1">
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Comentario"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); stopEditing(); } }}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full resize-y rounded-md border border-indigo-500 bg-white px-2 py-1 text-sm outline-none ring-1 ring-indigo-500 dark:bg-zinc-900" />
              <button type="button" onClick={stopEditing} title="Listo" aria-label="Listo"
                className="rounded p-1 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950"><Check className="size-4" /></button>
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-400">Enter para terminar · Mayús+Enter salto de línea · Esc deja el texto así</p>
          </div>
        ) : (
          <div className="mt-1 flex items-start gap-1">
            <p className="flex-1 whitespace-pre-line">
              {(owner?.name ?? pending.owner) && <span className="font-medium text-indigo-700 dark:text-indigo-300">@{owner?.name ?? pending.owner} </span>}
              {finalText}
            </p>
            <button type="button" onClick={() => setEditing(true)} title="Modificar el comentario" aria-label="Modificar el comentario"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"><Pencil className="size-3.5" /></button>
          </div>
        )}
        {!pending.owner && !owner && <p className="mt-1 text-xs text-amber-600">No tiene Owner en Rally: no se etiqueta a nadie como PO (con el lápiz puedes mencionar a alguien).</p>}
      </div>
      {step === 'ask' ? (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => publish(null)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">No quiero marcar analista</button>
          <button type="button" autoFocus onClick={() => setStep('pick')}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Sí, marcar analista</button>
        </div>
      ) : (
        <PickAnalyst busy={false} onAccept={publish} onSkip={() => publish(null)} />
      )}
      <p className="mt-3 text-xs text-zinc-400">{pending.closeHint ?? 'Si cierras esta ventana, la tarea no se mueve (ni aquí ni en Rally).'}</p>
    </Dialog>
  );
}

function PickAnalyst({ busy, onAccept, onSkip }: { busy: boolean; onAccept: (u: RallyRef) => void; onSkip: () => void }) {
  const last = lastAnalyst();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<RallyRef | null>(last);
  const [found, setFound] = useState<RallyRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setFound(null); return; }
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      rallyApi.searchUsers(text).then((u) => live && setFound(u), (e: Error) => live && setError(e.message));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const options = found ?? (last ? [last] : []);
  return (
    <>
      <div className="flex items-center gap-1.5 rounded-md border border-indigo-500 bg-white px-2 ring-1 ring-indigo-500 dark:bg-zinc-800">
        <Search className="size-4 text-indigo-600" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en Rally por nombre, usuario o email"
          className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      <div className="mt-2 max-h-64 min-h-16 overflow-y-auto">
        {!found && last && <p className="px-2 pb-1 text-xs font-bold tracking-wide text-zinc-500 uppercase">Última vez</p>}
        {options.map((u) => (
          <button key={u.ref} type="button" onClick={() => setChosen(u)} onDoubleClick={() => onAccept(u)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${chosen?.ref === u.ref ? 'bg-indigo-50 font-medium dark:bg-indigo-950' : ''}`}>
            <UserRound className="size-4 text-zinc-400" /><span className="flex-1">{u.name}</span>
            {chosen?.ref === u.ref && <Check className="size-4 text-indigo-600" />}
          </button>
        ))}
        {q.trim().length < 2 && !last && <p className="px-2 py-1 text-xs text-zinc-400">Escribe al menos 2 letras para buscar en Rally.</p>}
        {q.trim().length >= 2 && found === null && !error && <p className="px-2 py-1 text-xs text-zinc-400">Buscando en Rally…</p>}
        {found && !found.length && <p className="px-2 py-1 text-xs text-zinc-400">Nadie con ese nombre.</p>}
        {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" disabled={busy} onClick={onSkip}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">No quiero marcar analista</button>
        <button type="button" disabled={!chosen || busy} onClick={() => chosen && onAccept(chosen)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Aceptar</button>
      </div>
    </>
  );
}
