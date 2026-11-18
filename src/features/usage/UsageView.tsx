import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, User, Users } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { sync, useSync } from '../../data/sync';
import { addDays, formatDay } from '../../domain/dates';
import { dailyUsage, screenLabel, summarizeUsers, usedScreens, type UsageReport } from '../../domain/usage';
import { formatSeconds, screenKpis, type Kpi, type ScreenKpis } from '../../domain/usageKpis';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ViewHeader } from '../views/ViewHeader';

const PERIODS = [{ days: 7, label: '7 días' }, { days: 30, label: '30 días' }, { days: 90, label: '90 días' }];

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');

const card = 'rounded-lg border border-zinc-200 p-3 dark:border-zinc-700';
const th = 'px-2 py-1.5 text-left text-xs font-medium text-zinc-500 whitespace-nowrap';
const td = 'px-2 py-1.5 whitespace-nowrap';
const sectionTitle = 'mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase';
const num = (n: number) => (n ? n : <span className="text-zinc-300 dark:text-zinc-600">·</span>);

/**
 * Más → Analítica (solo administradores): vista de equipo (todas las cuentas) o de una persona, con los KPIs de cada
 * pantalla, el uso por persona y el uso día a día.
 */
export function UsageView() {
  const { isAdmin } = useSync();
  const { today } = useApp();
  const [days, setDays] = usePersistentState('analytics-period', 30);
  const [userId, setUserId] = useState<string | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const from = addDays(today, -(days - 1));
  useWideLayout(true);

  const load = useCallback(async () => {
    setError('');
    try { setReport(await sync().adminUsage(from, today)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [from, today]);
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  const people = useMemo(() => (report ? summarizeUsers(report) : []), [report]);
  const kpis = useMemo(() => (report ? screenKpis(report, userId ? [userId] : null) : []), [report, userId]);
  const daily = useMemo(() => (report ? dailyUsage(report, from, today, userId).filter((d) => d.sessions || Object.keys(d.screens).length) : []), [report, from, today, userId]);

  if (!isAdmin) return <><ViewHeader title="Analítica" /><p className="text-sm text-zinc-500">Solo los administradores ven la analítica de uso.</p></>;

  const selected = people.find((p) => p.user.id === userId) ?? null;
  const scope = selected ? [selected] : people;
  const totals = {
    sessions: scope.reduce((n, p) => n + p.sessions, 0),
    screens: scope.reduce((n, p) => n + p.screens, 0),
    active: scope.filter((p) => p.sessions || p.screens).length,
    days: selected?.activeDays ?? 0,
  };
  const missingKpis = !!report && report.users.length > 0 && !report.users[0].snapshot;
  const screens = usedScreens(daily);

  return (
    <>
      <ViewHeader title="Analítica" subtitle={selected ? `Uso de ${selected.user.name || selected.user.login}` : 'Uso de todo el equipo'}
        actions={<>
          <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
            <button type="button" onClick={() => setUserId(null)} aria-pressed={!selected}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${!selected ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
              <Users className="size-4" />Equipo
            </button>
            <label className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm ${selected ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500'}`}>
              <User className="size-4 shrink-0" />
              <select value={userId ?? ''} onChange={(e) => setUserId(e.target.value || null)} aria-label="Ver una persona"
                className="max-w-48 bg-transparent text-sm outline-none">
                <option value="">Una persona…</option>
                {[...(report?.users ?? [])].sort((a, b) => (a.name || a.login).localeCompare(b.name || b.login, 'es')).map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.login}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
            {PERIODS.map((p) => (
              <button key={p.days} type="button" onClick={() => setDays(p.days)} aria-pressed={days === p.days}
                className={`rounded-md px-2.5 py-1 text-sm ${days === p.days ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void load()} title="Actualizar"
            className="flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
            <RefreshCw className="size-3.5" />Actualizar
          </button>
        </>} />

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {!report && !error && <p className="text-sm text-zinc-400">Cargando…</p>}
      {missingKpis && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          Falta la migración <code>supabase/migrations/010_analitica_kpis.sql</code> en Supabase: sin ella solo se ven las entradas y las pantallas.
        </p>
      )}

      {report && (
        <div className="space-y-6">
          <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
            {selected ? (
              <Stat value={selected.last ? when(selected.last) : '—'} label="última vez" small />
            ) : (
              <Stat value={`${totals.active}`} extra={` de ${people.length}`} label="personas han entrado" />
            )}
            <Stat value={`${totals.sessions}`} label="entradas en la app" />
            <Stat value={`${totals.screens}`} label="pantallas abiertas" />
            {selected
              ? <Stat value={`${totals.days}`} extra={` de ${days}`} label="días con uso" />
              : <Stat value={totals.active ? (totals.sessions / totals.active).toFixed(1) : '—'} label="entradas por persona activa" />}
          </div>

          <section>
            <h2 className={sectionTitle}>KPIs por pantalla · {selected ? (selected.user.name || selected.user.login) : 'todo el equipo'}</h2>
            <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
              {kpis.map((k) => <ScreenCard key={k.id} block={k} team={!selected} />)}
            </div>
            <p className="mt-2 text-xs text-zinc-400">
              Una visita es «de calidad» si la pantalla está a la vista al menos 15 segundos o si se hace algo en ella. Las cifras de
              tareas, notas, grupos y fichas salen de los datos de cada persona en este momento; el resto, de lo que se ha hecho en el periodo.
            </p>
          </section>

          {!selected && (
            <section>
              <h2 className={sectionTitle}>Por persona</h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
                    <th className={th}>Persona</th><th className={`${th} text-right`}>Entradas</th><th className={`${th} text-right`}>Días con uso</th>
                    <th className={`${th} text-right`}>Pantallas abiertas</th><th className={th}>La que más usa</th><th className={th}>Última vez</th>
                  </tr></thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.user.id} onClick={() => setUserId(p.user.id)} title="Ver su analítica"
                        className={`cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${p.sessions || p.screens ? '' : 'text-zinc-400'}`}>
                        <td className={td}>
                          <div className="font-medium">{p.user.name || p.user.login}{p.user.disabled && <span className="ml-1.5 text-xs font-normal text-zinc-400">(desactivada)</span>}</div>
                          <div className="text-xs text-zinc-400">{p.user.login}</div>
                        </td>
                        <td className={`${td} text-right tabular-nums`}>{num(p.sessions)}</td>
                        <td className={`${td} text-right tabular-nums`}>{num(p.activeDays)}</td>
                        <td className={`${td} text-right tabular-nums`}>{num(p.screens)}</td>
                        <td className={td}>{p.top ? screenLabel(p.top) : '—'}</td>
                        <td className={td}>{when(p.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-xs text-zinc-400">Pulsa una persona para ver su analítica. Una entrada es abrir la app o volver a ella tras 30 minutos sin mirarla.</p>
            </section>
          )}

          <section>
            <h2 className={sectionTitle}>Por día · {selected ? (selected.user.name || selected.user.login) : 'todo el equipo'}</h2>
            {daily.length === 0 ? <p className="text-sm text-zinc-400">Sin uso en este periodo.</p> : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
                    <th className={th}>Día</th><th className={`${th} text-right`}>Entradas</th>
                    {screens.map((sc) => <th key={sc} className={`${th} text-right`}>{screenLabel(sc)}</th>)}
                  </tr></thead>
                  <tbody>
                    {daily.map((d) => (
                      <tr key={d.day} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className={`${td} first-letter:uppercase`}>{formatDay(d.day, today)}</td>
                        <td className={`${td} text-right font-medium tabular-nums`}>{num(d.sessions)}</td>
                        {screens.map((sc) => <td key={sc} className={`${td} text-right tabular-nums`}>{num(d.screens[sc] ?? 0)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Stat({ value, extra, label, small }: { value: string; extra?: string; label: string; small?: boolean }) {
  return (
    <div className={card}>
      <div className={`${small ? 'text-base' : 'text-2xl'} font-semibold tabular-nums`}>{value}{extra && <span className="text-base font-normal text-zinc-400">{extra}</span>}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

/** Tarjeta de una pantalla: sus visitas (cuántas, de calidad, tiempo medio, personas) y sus KPIs. */
export function ScreenCard({ block, team }: { block: ScreenKpis; team: boolean }) {
  const v = block.visits;
  return (
    <div className={card}>
      <h3 className="mb-2 font-semibold">{block.title}</h3>
      {v && (
        <div className="mb-2 grid grid-cols-4 gap-2 rounded-md bg-zinc-50 p-2 text-center dark:bg-zinc-800/50 max-sm:grid-cols-2">
          <Mini value={String(v.visits)} label="visitas" />
          <Mini value={`${v.quality}`} sub={pct(v.quality, v.visits)} label="de calidad" />
          <Mini value={formatSeconds(v.avgSeconds)} label="tiempo medio" />
          {team
            ? <Mini value={`${v.qualityPeople}`} sub={`de ${v.people} que entran`} label="personas de calidad" />
            : <Mini value={v.visits ? 'Sí' : 'No'} label="ha entrado" />}
        </div>
      )}
      {block.kpis.length > 0 && <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{block.kpis.map((k) => <KpiRow key={k.label} kpi={k} />)}</ul>}
      {!v?.visits && block.kpis.length === 0 && <p className="text-xs text-zinc-400">Sin uso en este periodo.</p>}
    </div>
  );
}

function Mini({ value, sub, label }: { value: string; sub?: string; label: string }) {
  return (
    <div>
      <div className="text-sm font-semibold tabular-nums">{value}{sub && <span className="ml-1 text-xs font-normal text-zinc-400">{sub}</span>}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}

function KpiRow({ kpi }: { kpi: Kpi }) {
  return (
    <li className="py-1.5 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">{kpi.label}</span>
        {kpi.people && <span className="shrink-0 text-xs text-zinc-400" title="Personas que lo hacen">{kpi.people.n} de {kpi.people.of} pers.</span>}
        <span className="shrink-0 font-semibold tabular-nums">{kpi.value}</span>
      </div>
      {kpi.hint && <div className="text-xs text-zinc-400">{kpi.hint}</div>}
      {kpi.parts && kpi.parts.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {kpi.parts.map((p) => (
            <span key={p.label} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {p.label} <span className="font-semibold tabular-nums">{p.value}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
