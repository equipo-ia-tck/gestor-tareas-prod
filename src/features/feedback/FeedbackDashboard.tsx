import { feedbackStats, type Feedback, type FeedbackKind, type FeedbackStatus } from '../../domain/feedback';

const STATUS_BAR: Record<FeedbackStatus, string> = {
  new: 'bg-indigo-500',
  doing: 'bg-amber-500',
  blocked: 'bg-red-500',
  done: 'bg-emerald-500',
  dismissed: 'bg-zinc-400',
};
const STATUS_LABEL: Record<FeedbackStatus, string> = { new: 'Nuevos', doing: 'En curso', blocked: 'Bloqueados', done: 'Hechos', dismissed: 'Descartados' };

const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

/**
 * Vista «Panel» de Más → Feedback: cómo va todo lo recibido. Las cifras y las barras se pulsan y llevan a la lista con ese
 * filtro.
 */
export function FeedbackDashboard({ items, onStatus, onKind, onArea }: {
  items: Feedback[];
  onStatus: (s: FeedbackStatus | 'open') => void;
  onKind: (k: FeedbackKind) => void;
  onArea: (a: string) => void;
}) {
  const s = feedbackStats(items);
  const resolved = s.total ? Math.round(((s.byStatus.done + s.byStatus.dismissed) / s.total) * 100) : 0;
  const maxWeek = Math.max(1, ...s.weeks.flatMap((w) => [w.received, w.closed]));
  const maxArea = Math.max(1, ...s.byArea.map((a) => a.total));
  const card = 'rounded-lg border border-zinc-200 p-3 dark:border-zinc-700';
  const title = 'mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase';

  return (
    <section className="mb-5">
      <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Recibidos" value={s.total} hint="Todo lo enviado" />
            <Tile label="Abiertos" value={s.open} hint="Nuevos, en curso y bloqueados" tone="text-indigo-700 dark:text-indigo-300" onClick={() => onStatus('open')} />
            <Tile label="Sin mirar" value={s.byStatus.new} hint="En estado Nuevo" tone="text-amber-700 dark:text-amber-300" onClick={() => onStatus('new')} />
            <Tile label="Resueltos" value={`${resolved}%`} hint={`${s.byStatus.done} hechos · ${s.byStatus.dismissed} descartados`} tone="text-emerald-700 dark:text-emerald-300" onClick={() => onStatus('done')} />
            <Tile label="Tiempo hasta Hecho" value={s.avgDaysToDone === null ? '—' : `${s.avgDaysToDone < 1 ? '<1' : Math.round(s.avgDaysToDone)} d`} hint="Media en días" />
          </div>

          {s.total > 0 && (
            <div className={card}>
              <p className={title}>Estado</p>
              <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                {(Object.keys(STATUS_BAR) as FeedbackStatus[]).map((k) => s.byStatus[k] > 0 && (
                  <button key={k} type="button" onClick={() => onStatus(k)} title={`${STATUS_LABEL[k]}: ${s.byStatus[k]}`}
                    className={`${STATUS_BAR[k]} hover:opacity-80`} style={{ width: `${(s.byStatus[k] / s.total) * 100}%` }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                {(Object.keys(STATUS_BAR) as FeedbackStatus[]).map((k) => (
                  <button key={k} type="button" onClick={() => onStatus(k)} className="inline-flex items-center gap-1.5 hover:underline">
                    <span className={`size-2.5 rounded-sm ${STATUS_BAR[k]}`} />{STATUS_LABEL[k]} <b>{s.byStatus[k]}</b>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className={card}>
              <p className={title}>Por semana · recibidos y cerrados</p>
              <div className="flex h-28 items-end gap-2">
                {s.weeks.map((w) => (
                  <div key={w.start} className="flex flex-1 flex-col items-center gap-1" title={`Semana del ${shortDay(w.start)}: ${w.received} recibidos, ${w.closed} cerrados`}>
                    <div className="flex h-20 w-full items-end justify-center gap-0.5">
                      <div className="w-1/3 rounded-t bg-indigo-400" style={{ height: `${(w.received / maxWeek) * 100}%`, minHeight: w.received ? 3 : 0 }} />
                      <div className="w-1/3 rounded-t bg-emerald-400" style={{ height: `${(w.closed / maxWeek) * 100}%`, minHeight: w.closed ? 3 : 0 }} />
                    </div>
                    <span className="text-[10px] whitespace-nowrap text-zinc-400">{shortDay(w.start)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-1 flex gap-4 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-indigo-400" />Recibidos</span>
                <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-emerald-400" />Cerrados (hechos o descartados)</span>
              </div>
            </div>

            <div className={card}>
              <p className={title}>Por parte de la web · abiertos / total</p>
              {!s.byArea.length && <p className="text-xs text-zinc-400">Aún no hay feedback.</p>}
              <ul className="space-y-1.5">
                {s.byArea.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => onArea(a.id)} className="group w-full text-left">
                      <span className="flex justify-between text-xs"><span className="group-hover:underline">{a.label}</span><span className="text-zinc-500"><b className="text-zinc-700 dark:text-zinc-200">{a.open}</b> / {a.total}</span></span>
                      <span className="mt-0.5 flex h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <span className="bg-indigo-500" style={{ width: `${(a.open / maxArea) * 100}%` }} />
                        <span className="bg-indigo-200 dark:bg-indigo-900" style={{ width: `${((a.total - a.open) / maxArea) * 100}%` }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className={card}>
              <p className={title}>Por tipo</p>
              <ul className="space-y-1 text-sm">
                {s.byKind.map((k) => (
                  <li key={k.id}>
                    <button type="button" onClick={() => onKind(k.id)} className="flex w-full justify-between rounded px-1 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                      <span>{k.label}</span><span className="text-zinc-500">{k.open} abiertos · {k.total}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {s.openBugs.some((b) => b.count) && (
                <p className="mt-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
                  Fallos abiertos: {s.openBugs.map((b, i) => <span key={b.id}>{i > 0 && ' · '}<b className={b.id === 'blocking' && b.count ? 'text-red-600 dark:text-red-400' : ''}>{b.count}</b> {b.label.toLowerCase()}</span>)}
                </p>
              )}
            </div>

            <div className={card}>
              <p className={title}>Quién envía</p>
              <ul className="space-y-1 text-sm">
                {s.authors.slice(0, 6).map((a) => (
                  <li key={a.name} className="flex justify-between px-1"><span className="truncate">{a.name}</span><span className="text-zinc-500">{a.total}</span></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
    </section>
  );
}

function Tile({ label, value, hint, tone = '', onClick }: { label: string; value: number | string; hint: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="block text-xs text-zinc-500">{label}</span>
      <span className={`block text-2xl font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="block text-[11px] text-zinc-400">{hint}</span>
    </>
  );
  const cls = 'rounded-lg border border-zinc-200 p-3 text-left dark:border-zinc-700';
  return onClick
    ? <button type="button" onClick={onClick} className={`${cls} hover:border-indigo-300 hover:bg-indigo-50/50 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30`}>{body}</button>
    : <div className={cls}>{body}</div>;
}
