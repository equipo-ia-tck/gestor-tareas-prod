import { track } from '../usage/track';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { RallyCc, RallyRef } from '../../domain/rally';
import type { CommentShape } from '../../domain/rallyComments';
import { Dialog } from './RallyPickers';
import { AddresseeRow, CcRow, MissingPeople, addresseeName, ccOf, initialPeople, missingPeople, type CommentPeopleValue } from './CommentPeople';

/**
 * Respuesta de la ventana: el texto y las personas (`to` en lugar del Owner, `noOwner` para no mencionar a nadie
 * primero, y el CC), `skip` (comentario opcional: seguir sin comentar) o `cancel` (la cruz, Esc o clic fuera).
 */
export type CommentAnswer = { text: string; owner: RallyRef | null; noOwner: boolean; cc: RallyCc[]; analyst: RallyRef | null } | 'skip' | 'cancel';
/** @deprecated nombre anterior. */
export type AnalystAnswer = CommentAnswer;

/** Comentario a la espera de saber a quién se menciona (todavía no se ha hecho nada en Rally). */
export interface PendingComment {
  /** FormattedID: "US1764574". */
  id: string;
  name: string;
  text: string;
  /** Owner en Rally (el PO). */
  owner: string | null;
  /** Cómo es este paso: a quién va, si es opcional, si se espera analista y si se propone a todos en el CC. */
  shape?: CommentShape;
  /** Personas propuestas en el CC (TS a Accepted: las ya mencionadas en el elemento). */
  cc?: RallyCc[];
  /** Qué pasa si se cierra la ventana (por defecto, que no se mueve). */
  closeHint?: string;
  /** Qué pasa con «Sin comentario» (solo si el comentario es opcional). */
  skipLabel?: string;
}

type Queued = PendingComment & { resolve: (a: CommentAnswer) => void };

// Cola en memoria: si se mueven varias a la vez, se pregunta de una en una.
let queue: Queued[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Abre la ventana del comentario (antes «¿Quieres marcar analista?»). */
export function askComment(c: PendingComment): Promise<CommentAnswer> {
  return new Promise<CommentAnswer>((resolve) => {
    queue = [...queue, { ...c, resolve }];
    emit();
  }).then((a) => { track('analyst', typeof a === 'string' ? a : a.analyst ? 'yes' : 'no'); return a; });
}
export const askAnalyst = askComment;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const current = () => queue[0] ?? null;
function answer(a: CommentAnswer) {
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

const OWNER_SHAPE: CommentShape = { addressee: 'owner', optional: false, analystExpected: false, ccEveryone: false };

/**
 * Antes de publicar un comentario en Rally (al mover, al bloquear o al quitar Ready): «Para» (el Owner, con el lápiz
 * para cambiarlo, o el analista / PO IT según el paso), el texto (lápiz) y «CC» con el analista (marcar o no) y
 * «+ Mencionar a alguien más». Las personas que se esperan se marcan en ámbar, pero no impiden publicar. Si el
 * comentario es opcional, «Sin comentario» sigue sin comentar. Cerrar (la cruz, Esc o clic fuera) cancela.
 */
export function AnalystPrompt() {
  const pending = useSyncExternalStore(subscribe, current);
  const shape = pending?.shape ?? OWNER_SHAPE;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState<CommentPeopleValue>({ to: null, analyst: null, others: [] });
  useEffect(() => {
    setText(pending?.text ?? '');
    setEditing(false);
    const s = pending?.shape ?? OWNER_SHAPE;
    setPeople(initialPeople(s.addressee, s.analystExpected, pending?.cc ?? []));
  }, [pending]);
  if (!pending) return null;

  const finalText = text.trim() || pending.text;
  const to = addresseeName(shape.addressee, pending.owner, people);
  const cc = ccOf(people);
  const missing = missingPeople(shape.addressee, shape.analystExpected, pending.owner, people);
  const publish = () => {
    const analyst = shape.addressee === 'analyst' ? people.to : people.analyst;
    if (analyst) rememberAnalyst(analyst);
    answer({ text: finalText, owner: people.to, noOwner: shape.addressee !== 'owner' && !people.to, cc, analyst });
  };
  const stopEditing = () => { setText(finalText); setEditing(false); };

  return (
    <Dialog title={shape.optional ? 'Comentario en Rally (opcional)' : 'Comentario en Rally'} width="max-w-lg" onClose={() => answer('cancel')}
      onEscape={editing ? stopEditing : undefined}>
      <p className="mb-2 text-xs text-zinc-500">{pending.id} · {pending.name}</p>
      <div className="space-y-2 rounded-md bg-zinc-50 p-2 text-sm dark:bg-zinc-800">
        <AddresseeRow addressee={shape.addressee} owner={pending.owner} value={people} onChange={setPeople} />
        {editing ? (
          <div>
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
          <div className="flex items-start gap-1 rounded border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
            <p className="flex-1 whitespace-pre-line">
              {to && <span className="font-medium text-indigo-700 dark:text-indigo-300">@{to} </span>}
              {finalText}
              {cc.length > 0 && <><br /><span className="text-zinc-500">CC: </span><span className="font-medium text-indigo-700 dark:text-indigo-300">{cc.map((p) => `@${p.name}`).join(' ')}</span></>}
            </p>
            <button type="button" onClick={() => setEditing(true)} title="Modificar el comentario" aria-label="Modificar el comentario"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"><Pencil className="size-3.5" /></button>
          </div>
        )}
        <CcRow addressee={shape.addressee} analystExpected={shape.analystExpected} value={people} onChange={setPeople} />
        <MissingPeople items={missing} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {shape.optional && (
          <button type="button" onClick={() => answer('skip')}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">{pending.skipLabel ?? 'Sin comentario'}</button>
        )}
        <button type="button" autoFocus onClick={publish}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Publicar</button>
      </div>
      <p className="mt-3 text-xs text-zinc-400">{pending.closeHint ?? 'Si cierras esta ventana, la tarea no se mueve (ni aquí ni en Rally).'}</p>
    </Dialog>
  );
}

