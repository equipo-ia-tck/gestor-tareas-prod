import { useState } from 'react';
import type { RallyItem, RallyRef } from '../../domain/rally';
import { lastAnalyst, rememberAnalyst } from './AnalystPrompt';
import { AnalystSearch } from './UserSearch';
import { rallyApi } from './rallyApi';
import { Dialog } from './RallyPickers';

export const UNREADY_TEXT = 'Tengo la lista validada por si la quieres revisar antes de la reunión con PO y PO IT';

/**
 * Al quitar Ready: propone publicar en la discusión «@Analista Tengo la lista validada…» (texto editable, analista
 * elegido en Rally; de entrada, el último). «No comentar» o cerrar no publica nada (Ready ya está quitado).
 */
export function UnreadyPrompt({ item, onClose, onPosted }: { item: RallyItem; onClose: () => void; onPosted: (message: string) => void }) {
  const [text, setText] = useState(UNREADY_TEXT);
  const [analyst, setAnalyst] = useState<RallyRef | null>(lastAnalyst);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = 'mb-0.5 block text-xs font-bold tracking-wide text-zinc-600 uppercase dark:text-zinc-300';

  const publish = async () => {
    if (!analyst || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await rallyApi.message(item.id, `@${analyst.name} ${text.trim()}`, [analyst]);
      rememberAnalyst(analyst);
      onPosted(`Comentado en ${item.id} para ${analyst.name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="¿Avisar al analista?" width="max-w-md" onClose={onClose}>
      <p className="mb-2 text-xs text-zinc-500">{item.id} · {item.name}</p>
      <div className="space-y-3">
        <div>
          <span className={label}>Comentario en la discusión</span>
          <div className="rounded-md border border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-800">
            {analyst
              ? <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">@{analyst.name}</span>
              : <span className="text-xs text-zinc-400">(elige al analista abajo)</span>}
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Comentario"
              className="mt-1 w-full resize-y rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
        </div>
        <div><span className={label}>Analista</span><AnalystSearch value={analyst} onChange={setAnalyst} /></div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">No comentar</button>
          <button type="button" disabled={busy || !analyst || !text.trim()} onClick={() => void publish()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">{busy ? 'Publicando…' : 'Publicar'}</button>
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-400">Ready ya está quitado. Si cierras esta ventana no se comenta nada.</p>
    </Dialog>
  );
}
