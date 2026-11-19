import { useState } from 'react';
import { Ban, Check } from 'lucide-react';
import type { RallyItem } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { askComment } from './AnalystPrompt';
import { blockedText, commentShape, unreadyText } from '../../domain/rallyComments';
import { rallyApi } from './rallyApi';
import { rememberRally } from './rallyStore';
import { RallyMessage } from './RallyMessage';


/**
 * Botones Ready y Blocked de la ficha, como en Rally. No cambian el elemento de columna (ni la tarea de bloque en el
 * gestor). Blocked abre la misma ventana que mover a Bloqueado: comentario con el PO (editable con el lápiz) y analista;
 * al aceptar marca Blocked con ese texto como motivo y lo publica en la discusión. Cerrar la ventana no cambia nada.
 * Marcar Ready abre antes «Mensaje» (`RallyMessage`: plantillas y personas de Rally etiquetadas); Ready se marca al publicar o con «Sin mensaje», y cerrar con la cruz no lo marca
 * (Esc o clic fuera tampoco). Quitar Ready abre la ventana de los movimientos (`askComment`): en una US, «Tengo la guía
 * validada…» para el Owner, y Ready solo se quita si se envía (si se cierra, sigue marcado; si el comentario falla, se
 * vuelve a marcar); en un TS, el mismo comentario opcional que al pasar a Completed, para el analista.
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
    // Marcar Ready: primero el mensaje; Ready se marca al publicar o con «Sin mensaje» (la cruz no marca nada).
    if (!item.ready) { setMessage(item); return null; }
    // US: Ready solo se quita si se envía el comentario. Primero la ventana; si se cierra, Ready no se toca; si el
    // comentario falla después de quitarlo, Ready se vuelve a marcar solo.
    if (item.kind === 'US') {
      const answer = await askComment({ id: item.id, name: item.name, text: unreadyText(item.kind), owner: item.owner,
        shape: commentShape(item.kind, 'unready'),
        closeHint: 'Ready solo se quita si envías el comentario. Si cierras esta ventana, Ready se queda marcado.' });
      if (answer === 'cancel' || answer === 'skip') { setNote('Ready sigue marcado: no se ha enviado el comentario.'); return null; }
      const unready = await rallyApi.flag(item.id, { ready: false });
      try {
        const r = await rallyApi.moveComment(item.id, answer.text, answer);
        setNote(`Ready quitado y comentado en ${item.id}${r.owner ? ` para ${r.owner}` : ''}${r.cc.length ? ` · CC ${r.cc.join(', ')}` : ''}`);
        return unready;
      } catch (e) {
        const back = await rallyApi.flag(item.id, { ready: true }).catch(() => null);
        setNote(back
          ? `No se ha podido comentar (${(e as Error).message}), así que Ready se ha vuelto a marcar.`
          : `No se ha podido comentar ni volver a marcar Ready: márcalo a mano en Rally. ${(e as Error).message}`);
        return back ?? unready;
      }
    }
    const updated = await rallyApi.flag(item.id, { ready: false });
    if (updated.ready) setMessage(updated);
    else if (item.ready) {
      // Ready ya está quitado: ahora la misma ventana que al mover (lápiz, mención del PO cambiable y analista).
      rememberRally([updated]);
      onChanged(updated);
      const answer = await askComment({ id: item.id, name: item.name, text: unreadyText(item.kind), owner: item.owner,
        shape: commentShape(item.kind, 'unready'), skipLabel: 'Sin comentario',
        closeHint: 'Ready ya está quitado. Si cierras esta ventana no se comenta nada.' });
      if (answer !== 'cancel' && answer !== 'skip') {
        try {
          const r = await rallyApi.moveComment(item.id, answer.text, answer);
          setNote(`Comentado en ${item.id}${r.owner ? ` para ${r.owner}` : ''}${r.cc.length ? ` · CC ${r.cc.join(', ')}` : ''}`);
        } catch (e) {
          setNote(`Ready quitado, pero no se ha podido comentar: ${(e as Error).message}`);
        }
      }
    }
    return updated;
  });
  const toggleBlocked = () => run(async () => {
    if (item.blocked) return rallyApi.flag(item.id, { blocked: false });
    const answer = await askComment({ id: item.id, name: item.name, text: blockedText(item.kind), owner: item.owner,
      shape: commentShape(item.kind, 'blocked'), closeHint: 'Si cierras esta ventana, no se marca Blocked ni se comenta.' });
    if (answer === 'cancel' || answer === 'skip') return null;
    const updated = await rallyApi.flag(item.id, { blocked: true, reason: answer.text });
    try {
      await rallyApi.moveComment(item.id, answer.text, answer);
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
          onConfirm={async () => {
            const updated = await rallyApi.flag(message.id, { ready: true });
            rememberRally([updated]);
            onChanged(updated);
          }}
          onPosted={setNote} />
      )}
    </div>
  );
}
