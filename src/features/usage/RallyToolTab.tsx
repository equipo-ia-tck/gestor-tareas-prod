import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Info, RefreshCw, Wrench } from 'lucide-react';
import { sync } from '../../data/sync';
import { addDays } from '../../domain/dates';
import type { RallyProject } from '../../domain/rally';
import { artifactHash, beforeTracking, CHANGE_KINDS, matchTool, summarizeActivity, type ActivitySummary, type RallyActivity, type Split } from '../../domain/rallyActivity';
import { fold } from '../../domain/text';
import type { UsageUser } from '../../domain/usage';
import { usePersistentState } from '../../hooks/usePersistentState';
import { rallyApi } from '../rally/rallyApi';
import { DEFAULT_PROJECT, ProjectPicker } from '../rally/RallyView';

/** Herramienta (azul) y directamente en Rally (naranja): los dos primeros colores de la paleta categórica. */
const TOOL = 'bg-[#2a78d6] dark:bg-[#3987e5]';
const RALLY = 'bg-[#eb6834] dark:bg-[#d95926]';
const card = 'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700/80 dark:bg-zinc-900';
const cardTitle = 'text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400';
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const when = (iso: string) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

/**
 * Pestaña «Rally» de Más → Analítica: de todos los cambios hechos en Rally en el periodo (en los proyectos elegidos),
 * cuántos salen de la herramienta y cuántos se hacen directamente en Rally, por tipo, por semana y por persona.
 * Se lee Rally con la clave de quien mira (tiene que tenerlo conectado) y se cruza con lo que apunta la herramienta.
 */
/** `onlyPeople`: en la analítica se han elegido personas: solo cuentan los cambios de Rally hechos por ellas (por nombre). */
export function RallyToolTab({ from, to, users, onlyPeople = false }: { from: string; to: string; users: UsageUser[]; onlyPeople?: boolean }) {
  const [projects, setProjects] = useState<RallyProject[] | null>(null);
  const [stored, setStored] = usePersistentState<string[] | null>('analytics-rally-projects', null);
  const [scope, setScope] = usePersistentState('analytics-rally-scope', { down: true, up: false });
  const [result, setResult] = useState<Loaded | null>(null);
  const [onlySince, setOnlySince] = usePersistentState('analytics-rally-only-since', false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [reload, setReload] = useState(0);
  const selected = stored ?? [];

  useEffect(() => {
    rallyApi.status().then((s) => {
      setConnected(s.connected);
      if (!s.connected) return;
      rallyApi.projects().then((list) => {
        setProjects(list);
        if (stored === null) {
          const team = list.find((p) => p.name === DEFAULT_PROJECT);
          setStored(team ? [team.id] : []);
        }
      }, (e: Error) => setError(e.message));
    }, (e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const key = selected.join(',');
  useEffect(() => {
    if (!connected || !key) return;
    let live = true;
    // Del principio del primer día al principio del día siguiente al último, en hora local.
    const fromIso = new Date(`${from}T00:00:00`).toISOString();
    const toIso = new Date(`${addDays(to, 1)}T00:00:00`).toISOString();
    setLoading(true);
    setError('');
    (async () => {
      const [activity, tool] = await Promise.all([
        rallyApi.activity(fromIso, toIso, key.split(','), scope),
        sync().adminRallyTool(fromIso, toIso),
      ]);
      const unique = [...new Set(activity.changes.map((c) => c.artifact))];
      const hashOf = new Map(await Promise.all(unique.map(async (id) => [id, await artifactHash(id)] as const)));
      const fromTool = matchTool(activity.changes, activity.changes.map((c) => hashOf.get(c.artifact)!), tool.rows);
      if (live) setResult({ activity, fromTool, since: tool.since, toolCount: tool.rows.filter((r) => Date.parse(r.at) >= Date.parse(fromIso) && Date.parse(r.at) < Date.parse(toIso)).length });
    })().catch((e: Error) => {
      if (!live) return;
      setError(/admin_rally_tool|rally_tool/.test(e.message)
        ? 'Falta la migración supabase/migrations/011_rally_herramienta.sql en Supabase.' : e.message);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [connected, key, scope.down, scope.up, from, to, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const accounts = useMemo(() => new Set(users.flatMap((u) => [fold(u.name), fold(u.login.split('@')[0].replace(/[._]/g, ' '))])), [users]);

  if (connected === false) {
    return <div className={card}><p className="text-sm text-zinc-500">Para ver esto, conecta Rally en la pantalla <b>Rally</b>: los cambios se leen con tu clave.</p></div>;
  }

  // Con personas elegidas, solo sus cambios (la persona de Rally se compara por nombre con las cuentas elegidas).
  const shown = useMemo<Loaded | null>(() => {
    if (!result || !onlyPeople) return result;
    const keep = result.activity.changes.map((c) => accounts.has(fold(c.user)));
    return {
      ...result,
      activity: { ...result.activity, changes: result.activity.changes.filter((_, i) => keep[i]) },
      fromTool: result.fromTool.filter((_, i) => keep[i]),
    };
  }, [result, onlyPeople, accounts]);
  const summary = useMemo(() => (shown ? summarizeActivity(shown.activity.changes, shown.fromTool, shown.since, onlySince) : null), [shown, onlySince]);
  const s = summary;
  const total = s ? s.total.tool + s.total.rally : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-500">Proyectos de Rally:</span>
        {projects && <ProjectPicker projects={projects} selected={selected} onChange={setStored} scope={scope} onScope={setScope} recent={[]} />}
        <button type="button" onClick={() => setReload((n) => n + 1)} disabled={loading}
          className="flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />Leer Rally
        </button>
        {loading && <span className="text-xs text-zinc-400">Leyendo los cambios de Rally… puede tardar un poco.</span>}
      </div>

      {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {!selected.length && projects && <p className="text-sm text-zinc-500">Elige al menos un proyecto.</p>}

      {result && s && (
        <>
          <Notices result={result} summary={s} onlySince={onlySince} onOnlySince={setOnlySince} />

          <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
            <div className={`${card} border-t-4 border-t-[#2a78d6] dark:border-t-[#3987e5]`}>
              <h3 className={`${cardTitle} mb-2`}>Cambios en Rally</h3>
              {total ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tabular-nums">{pct(s.total.tool, total)} %</span>
                    <span className="text-sm text-zinc-500">desde la herramienta</span>
                  </div>
                  <SplitBar split={s.total} tall />
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <Figure cls={TOOL} label="Desde la herramienta" n={s.total.tool} total={total} />
                    <Figure cls={RALLY} label="Directamente en Rally" n={s.total.rally} total={total} />
                  </div>
                  <p className="mt-3 text-xs text-zinc-400">{total} cambios en el periodo en los proyectos elegidos. La herramienta ha apuntado {result.toolCount} escrituras en Rally en el periodo (de cualquier proyecto).</p>
                </>
              ) : <p className="py-6 text-center text-sm text-zinc-400">Ningún cambio en este periodo. La herramienta ha apuntado {result.toolCount} escrituras en Rally.</p>}
            </div>

            <div className={`${card} col-span-2 max-lg:col-span-1`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className={cardTitle}>Por tipo de cambio</h3>
                <Legend />
              </div>
              <ul className="space-y-3">
                {s.byKind.map((k) => {
                  const n = k.tool + k.rally;
                  return (
                    <li key={k.kind}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                        <span>{k.label}</span>
                        <span className="text-xs text-zinc-500 tabular-nums">
                          {n ? <><b className="text-zinc-800 dark:text-zinc-100">{pct(k.tool, n)} %</b> herramienta · {k.tool} de {n}</> : 'sin cambios'}
                          {result.activity.truncated.includes(k.kind) && <span className="ml-1 text-amber-600" title="Hay más de los que se han podido leer">(mínimo)</span>}
                        </span>
                      </div>
                      <SplitBar split={k} />
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className={card}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className={cardTitle}>Evolución por semana</h3>
              <Legend />
            </div>
            <WeekBars weeks={s.byWeek} />
          </div>

          <div className={`${card} overflow-hidden p-0`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h3 className={cardTitle}>Por persona (quien hace el cambio en Rally)</h3>
              <Legend />
            </div>
            {!s.byPerson.length ? <p className="py-6 text-center text-sm text-zinc-400">Nadie ha hecho cambios en este periodo.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500">Persona</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-zinc-500">En la herramienta</th>
                    <th className="min-w-56 px-4 py-2 text-left text-xs font-medium text-zinc-500">Herramienta / Rally</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500">% herramienta</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-zinc-500">Cambios</th>
                  </tr></thead>
                  <tbody>
                    {s.byPerson.map((p) => {
                      const n = p.tool + p.rally;
                      const hasAccount = accounts.has(fold(p.user));
                      return (
                        <tr key={p.user} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="px-4 py-2 font-medium whitespace-nowrap">{p.user}</td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            {hasAccount
                              ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Tiene cuenta</span>
                              : <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title="No hay ninguna cuenta con este nombre">Sin cuenta</span>}
                          </td>
                          <td className="px-4 py-2"><SplitBar split={p} /></td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">{pct(p.tool, n)} %</td>
                          <td className="px-4 py-2 text-right text-zinc-500 tabular-nums">{p.tool} / {p.rally}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <ChangeList result={shown!} onlySince={onlySince} />

          <p className="flex gap-2 text-xs text-zinc-400">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Rally no guarda desde dónde se hace cada cambio. La herramienta apunta todo lo que escribe en Rally (sin el ID ni el
              texto: solo el tipo, una huella del elemento y la hora) y aquí se cruza con el historial de Rally: un cambio es «de la
              herramienta» si se apuntó uno del mismo tipo en el mismo elemento a menos de 5 minutos. Se leen discusiones, archivos,
              Flow State, Ready, Blocked y altas de los proyectos elegidos{scope.down ? ' y sus hijos' : ''}{scope.up ? ' y sus padres' : ''}.
              «Tiene cuenta» compara el nombre de Rally con las cuentas de la herramienta. El historial de Rally (Flow State, Ready,
              Blocked y altas) puede tardar unos minutos en reflejar un cambio recién hecho.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

type Loaded = { activity: RallyActivity; fromTool: boolean[]; since: string | null; toolCount: number };

function Notices({ result, summary, onlySince, onOnlySince }: { result: Loaded; summary: ActivitySummary; onlySince: boolean; onOnlySince: (v: boolean) => void }) {
  const { since, activity } = result;
  return (
    <div className="space-y-2">
      {!since && (
        <Note icon={Wrench}>La herramienta todavía no ha apuntado ningún cambio en Rally: hasta que lo haga, todo cuenta como hecho en Rally.</Note>
      )}
      {since && summary.before > 0 && (
        <Note icon={Info}>
          <span className="block">
            La herramienta apunta lo que escribe en Rally desde el {when(since)}. {summary.before} {summary.before === 1 ? 'cambio es' : 'cambios son'} de
            antes{onlySince ? ' y no se cuentan.' : ': si alguno se hizo desde la herramienta, aquí cuenta como Rally.'}
          </span>
          <label className="mt-1 inline-flex cursor-pointer items-center gap-1.5 font-medium">
            <input type="checkbox" checked={onlySince} onChange={(e) => onOnlySince(e.target.checked)} />
            Contar solo desde que se mide
          </label>
        </Note>
      )}
      {activity.errors.map((e) => (
        <Note key={e.kinds.join()} icon={AlertTriangle} warn>No se han podido leer {e.kinds.length > 1 ? 'algunos tipos de cambio' : 'un tipo de cambio'} ({e.kinds.join(', ')}): {e.message}</Note>
      ))}
      {activity.truncated.length > 0 && (
        <Note icon={AlertTriangle} warn>Hay más cambios de los que se pueden leer de una vez ({activity.truncated.join(', ')}): acorta el periodo o elige menos proyectos.</Note>
      )}
    </div>
  );
}

const KIND_LABEL = Object.fromEntries(CHANGE_KINDS.map((k) => [k.id, k.label]));

/** Cada cambio leído de Rally, del más reciente al más antiguo, con su origen: para comprobar las cifras. */
function ChangeList({ result, onlySince }: { result: Loaded; onlySince: boolean }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const rows = result.activity.changes.map((c, i) => ({ c, tool: result.fromTool[i], before: beforeTracking(c.at, result.since) })).reverse();
  return (
    <div className={`${card} p-0`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left">
        <span className={cardTitle}>Cambios leídos de Rally ({rows.length})</span>
        <ChevronDown className={`size-4 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-zinc-100 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
              {['Cuándo', 'Tipo', 'Elemento', 'Persona', 'Origen'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-medium text-zinc-500">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.slice(0, limit).map(({ c, tool, before }, i) => (
                <tr key={i} className={`border-t border-zinc-100 dark:border-zinc-800 ${before && onlySince ? 'opacity-40' : ''}`}>
                  <td className="px-4 py-1.5 whitespace-nowrap text-zinc-500">{when(c.at)}</td>
                  <td className="px-4 py-1.5 whitespace-nowrap">{KIND_LABEL[c.kind]}{c.kind === 'flow' && c.to ? <span className="text-zinc-400"> → {c.to}</span> : null}</td>
                  <td className="px-4 py-1.5 font-mono text-xs whitespace-nowrap">{c.artifact}</td>
                  <td className="px-4 py-1.5 whitespace-nowrap">{c.user}</td>
                  <td className="px-4 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${tool ? TOOL : RALLY}`} />{tool ? 'Herramienta' : 'Rally'}</span>
                    {before && <span className="ml-1.5 text-xs text-zinc-400">(antes de medir)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <button type="button" onClick={() => setLimit(limit + 200)} className="w-full border-t border-zinc-100 px-4 py-2 text-sm text-indigo-600 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800">
              Ver más ({rows.length - limit})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Note({ icon: Icon, children, warn }: { icon: typeof Info; children: React.ReactNode; warn?: boolean }) {
  return (
    <p className={`flex gap-2 rounded-md border px-3 py-2 text-sm ${warn
      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
      : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200'}`}>
      <Icon className="mt-0.5 size-4 shrink-0" /><span>{children}</span>
    </p>
  );
}

function SplitBar({ split, tall }: { split: Split; tall?: boolean }) {
  const n = split.tool + split.rally;
  if (!n) return <div className={`${tall ? 'mt-3 h-4' : 'h-2.5'} rounded-full bg-zinc-100 dark:bg-zinc-800`} />;
  return (
    <div className={`${tall ? 'mt-3 h-4' : 'h-2.5'} flex gap-[2px] overflow-hidden rounded-full`}
      title={`Herramienta ${split.tool} · Rally ${split.rally}`} role="img" aria-label={`Herramienta ${split.tool}, Rally ${split.rally}`}>
      {split.tool > 0 && <div className={TOOL} style={{ width: `${(split.tool / n) * 100}%` }} />}
      {split.rally > 0 && <div className={RALLY} style={{ width: `${(split.rally / n) * 100}%` }} />}
    </div>
  );
}

function Figure({ cls, label, n, total }: { cls: string; label: string; n: number; total: number }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500"><span className={`size-2.5 rounded-sm ${cls}`} />{label}</div>
      <div className="text-xl font-semibold tabular-nums">{n} <span className="text-sm font-normal text-zinc-400">· {pct(n, total)} %</span></div>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex gap-3 text-xs text-zinc-500">
      <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${TOOL}`} />Desde la herramienta</span>
      <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${RALLY}`} />Directamente en Rally</span>
    </span>
  );
}

function WeekBars({ weeks }: { weeks: ActivitySummary['byWeek'] }) {
  if (!weeks.length) return <p className="py-6 text-center text-sm text-zinc-400">Sin cambios en este periodo.</p>;
  const max = Math.max(1, ...weeks.map((w) => w.tool + w.rally));
  return (
    <div>
      <div className="flex h-44 items-end gap-2 border-b border-zinc-200 dark:border-zinc-700">
        {weeks.map((w) => {
          const n = w.tool + w.rally;
          return (
            <div key={w.week} className="group relative flex h-full flex-1 flex-col items-center justify-end">
              <span className="mb-1 text-[11px] font-medium text-zinc-500 tabular-nums">{pct(w.tool, n)} %</span>
              <div className="flex w-full max-w-16 flex-col-reverse gap-[2px]" style={{ height: `${(n / max) * 80}%` }}>
                {w.tool > 0 && <div className={`${TOOL} rounded-b-[2px]`} style={{ flexGrow: w.tool }} />}
                {w.rally > 0 && <div className={`${RALLY} rounded-t-[4px]`} style={{ flexGrow: w.rally }} />}
              </div>
              <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md bg-zinc-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
                <b>Semana del {shortDay(w.week)}</b><br />{w.tool} desde la herramienta · {w.rally} en Rally
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-2 text-[10px] text-zinc-400">
        {weeks.map((w) => <span key={w.week} className="flex-1 text-center whitespace-nowrap">{shortDay(w.week)}</span>)}
      </div>
    </div>
  );
}
