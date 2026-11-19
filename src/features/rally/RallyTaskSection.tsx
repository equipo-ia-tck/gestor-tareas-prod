import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Layers } from 'lucide-react';
import { isRallyId, type RallyDetail, type RallyItem } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { RallyDetailBody } from './RallyDetailPanel';
import { rallyApi } from './rallyApi';
import { rememberRally } from './rallyStore';
import { RallyFlags } from './RallyFlags';

/**
 * Ficha de Rally dentro del panel de una tarea enlazada (por su ID externo): la misma información que en la pantalla
 * Rally. Se vuelve a cargar cuando la tarea cambia de estado (y por tanto Rally también). Sin Rally conectado no se ve.
 */
export function RallyTaskSection({ task }: { task: Task }) {
  const externalId = task.external_id;
  const [root, setRoot] = useState<RallyItem | null>(null);
  // Elemento relacionado abierto dentro de la sección (null = el de la tarea).
  const [nested, setNested] = useState<RallyItem | null>(null);
  const [detail, setDetail] = useState<RallyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!isRallyId(externalId)) return;
    let alive = true;
    setNested(null);
    setError(null);
    rallyApi.lookup([externalId!])
      .then(([item]) => {
        if (!alive) return;
        if (!item) setError(`${externalId} no aparece en Rally.`);
        else rememberRally([item]);
        setRoot(item ?? null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        // Sin Rally conectado, la sección no se muestra.
        if (/Conecta Rally/.test(e.message)) setHidden(true);
        else setError(e.message);
      });
    return () => { alive = false; };
  }, [externalId, task.state_id]);

  const current = nested ?? root;
  useEffect(() => {
    if (!current) return;
    let alive = true;
    setDetail(null);
    rallyApi.detail(current).then((d) => { if (alive) setDetail(d); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [current]);

  if (!isRallyId(externalId) || hidden) return null;
  const shown = detail?.item ?? current;
  // Tras Ready/Blocked: se ve al momento y se vuelve a leer la ficha (motivo y comentario nuevos) sin vaciarla.
  const flagged = (updated: RallyItem) => {
    setDetail((d) => (d ? { ...d, item: updated } : d));
    rallyApi.detail(updated).then(setDetail, () => {});
  };

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
      <header className="flex flex-wrap items-center gap-2 bg-zinc-50 px-4 py-2 text-xs dark:bg-zinc-900">
        <Layers className="size-4 text-indigo-500" />
        <span className="font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Rally</span>
        {nested && (
          <button type="button" onClick={() => setNested(null)} className="inline-flex items-center gap-1 text-indigo-600 hover:underline">
            <ArrowLeft className="size-3" />{root?.id}
          </button>
        )}
        {shown && (
          <>
            <a href={shown.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-indigo-600 hover:underline" title="Abrir en Rally">
              {shown.id}<ExternalLink className="size-3" />
            </a>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">{shown.state}</span>
            {shown.assignee && <span className="text-zinc-500">Assignee: <b className={shown.mine ? 'text-indigo-600 dark:text-indigo-400' : ''}>{shown.mine ? 'Tú' : shown.assignee}</b></span>}
          </>
        )}
      </header>
      {nested && <p className="px-4 pt-3 text-sm font-semibold">{nested.name}</p>}
      {shown && <div className="px-4"><RallyFlags item={shown} task={shown.id === task.external_id ? task : undefined} reason={detail?.blockedReason ?? null} onChanged={flagged} /></div>}
      <div className="pt-3">
        {current
          ? <RallyDetailBody item={current} detail={detail} error={error} onSelect={setNested}
            task={current.id === task.external_id ? task : undefined} onDetail={(d) => { setDetail(d); if (!nested) setRoot(d.item); }} />
          : error
            ? <p className="mx-4 mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
            : <p className="px-4 pb-3 text-sm text-zinc-500">Buscando en Rally…</p>}
      </div>
    </section>
  );
}
