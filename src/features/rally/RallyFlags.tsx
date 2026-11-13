import { useState } from 'react';
import { Ban, Check } from 'lucide-react';
import type { RallyItem } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { askAnalyst } from './AnalystPrompt';
import { rallyApi } from './rallyApi';
import { rememberRally } from './rallyStore';
import { RallyMessage } from './RallyMessage';

const BLOCK_COMMENT = 'Guía bloqueada';
/** Comentario que se propone al quitar Ready (con el PO y el analista, como al mover). */
export const UNREADY_TEXT = 'Tengo la lista validada por si la quieres revisar antes de la reunión con PO y PO IT';

/**
 * Botones Ready y Blocked de la ficha, como en Rally. No cambian el elemento de columna (ni la tarea de bloque en el
 * gestor). Blocked abre la misma ventana que mover a Bloqueado: comentario con el PO (editable con el lápiz) y analista;
 * al aceptar marca Blocked con ese texto como motivo y lo publica en la discusión. Cerrar la ventana no cambia nada.
 * Marcar Ready abre después «Mensaje» (`RallyMessage`: plantillas y personas de Rally etiquetadas); Ready queda marcado
 * aunque se cierre sin mensaje. Quitar Ready abre la ventana de los movimientos (`askAnalyst`) con «Tengo la lista validada…».
 */
export function RallyFlags({ item, task, reason, onChanged }: {
  item: RallyItem;
  /** Tarea del gestor enlazada a este elemento, si la hay (rellena mejor la plantilla). */
  task?: Task;
  reason: string | null;
  onChanged: (item: RallyItem) => void;
}) {
  const [message, setMessage] = useState<RallyItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (item.kind === 'TC' || item.kind === 'FE') return null;

  const run = async (fn: () => Promise<RallyItem | null>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await fn();
      if (updated) { rememberRally([updated]); onChanged(updated); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleReady = () => run(async () => {
    const updated = await rallyApi.flag(item.id, { ready: !item.ready });
    if (updated.ready) setMessage(updated);
    else if (item.ready) {
      // Ready ya está quitado: ahora la misma ventana que al mover (lápiz, mención del PO cambiable y analista).
      rememberRally([updated]);
      onChanged(updated);
      const answer = await askAnalyst({ id: item.id, name: item.name, text: UNREADY_TEXT, owner: item.owner,
        closeHint: 'Ready ya está quitado. Si cierras esta ventana no se comenta nada.' });
      if (answer !== 'cancel') {
        try {
          const r = await rallyApi.moveComment(item.id, answer.text, answer.analyst, answer.owner);
          setNote(`Comentado en ${item.id}${r.owner ? ` para ${r.owner}` : ''}${r.analyst ? ` · analista ${r.analyst}` : ''}`);
        } catch (e) {
          setNote(`Ready quitado, pero no se ha podido comentar: ${(e as Error).message}`);
        }
      }
    }
    return updated;
  });
  const toggleBlocked = () => run(async () => {
    if (item.blocked) return rallyApi.flag(item.id, { blocked: false });
    const answer = await askAnalyst({ id: item.id, name: item.name, text: BLOCK_COMMENT, owner: item.owner,
      closeHint: 'Si cierras esta ventana, no se marca Blocked ni se comenta.' });
    if (answer === 'cancel') return null;
    const updated = await rallyApi.flag(item.id, { blocked: true, reason: answer.text });
    try {
      await rallyApi.moveComment(item.id, answer.text, answer.analyst, answer.owner);
    } catch (e) {
      setNote(`Bloqueada, pero no se ha podido comentar: ${(e as Error).message}`);
    }
    return updated;
  });

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" disabled={busy} onClick={() => void toggleReady()} aria-pressed={item.ready}
          title={item.ready ? 'Quitar Ready' : 'Marcar Ready'}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 disabled:opacity-50 ${item.ready
            ? 'border-green-600 bg-green-600 text-white hover:bg-green-700'
            : 'border-indigo-600 text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950'}`}>
          <Check className="size-4" /> Ready
        </button>
        <button type="button" disabled={busy} onClick={() => void toggleBlocked()} aria-pressed={item.blocked}
          title={item.blocked ? 'Quitar Blocked' : 'Marcar Blocked (pide el comentario)'}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 font-medium disabled:opacity-50 ${item.blocked
            ? 'border-red-600 bg-red-600 text-white hover:bg-red-700'
            : 'border-red-600 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950'}`}>
          <Ban className="size-4" /> Blocked
        </button>
        {item.blocked && reason && (
          <span className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300" title={reason}>
            {reason}
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {note && <p className="mt-1 text-xs text-amber-600">{note}</p>}
      {message && (
        <RallyMessage item={message} task={task} onClose={() => setMessage(null)}
          onPosted={(m) => { setNote(m); onChanged(message); }} />
      )}
    </div>
  );
}
