import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { sync, useSync } from '../../data/sync';
import { addDays, formatDay } from '../../domain/dates';
import { activeUsers, dailyUsage, screenLabel, summarizeUsers, usedScreens, type UsageReport } from '../../domain/usage';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ViewHeader } from '../views/ViewHeader';

const PERIODS = [{ days: 7, label: '7 días' }, { days: 30, label: '30 días' }, { days: 90, label: '90 días' }];

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

/** Más → Analítica: cuántas veces entra cada persona en la app y a qué pantallas, por día. Solo administradores. */
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
  const daily = useMemo(() => (report ? dailyUsage(report, from, today, userId).filter((d) => d.sessions || Object.keys(d.screens).length) : []), [report, from, today, userId]);
  const screens = usedScreens(daily);

  if (!isAdmin) return <><ViewHeader title="Analítica" /><p className="text-sm text-zinc-500">Solo los administradores ven la analítica de uso.</p></>;

  const selected = people.find((p) => p.user.id === userId);
  const totals = { sessions: people.reduce((n, p) => n + p.sessions, 0), screens: people.reduce((n, p) => n + p.screens, 0) };
  const card = 'rounded-lg border border-zinc-200 p-3 dark:border-zinc-700';
  const th = 'px-2 py-1.5 text-left text-xs font-medium text-zinc-500 whitespace-nowrap';
  const td = 'px-2 py-1.5 whitespace-nowrap';
  const num = (n: number) => (n ? n : <span className="text-zinc-300 dark:text-zinc-600">·</span>);

  return (
    <>
      <ViewHeader title="Analítica" subtitle="Cuántas veces entra cada persona en la app y qué pantallas abre, por día"
        actions={<>
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

      {report && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
            <div className={card}><div className="text-2xl font-semibold tabular-nums">{activeUsers(report)}<span className="text-base font-normal text-zinc-400"> de {report.users.length}</span></div><div className="text-xs text-zinc-500">personas han entrado</div></div>
            <div className={card}><div className="text-2xl font-semibold tabular-nums">{totals.sessions}</div><div className="text-xs text-zinc-500">entradas en la app</div></div>
            <div className={card}><div className="text-2xl font-semibold tabular-nums">{totals.screens}</div><div className="text-xs text-zinc-500">pantallas abiertas</div></div>
          </div>

          <section>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Por persona</h2>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
                  <th className={th}>Persona</th><th className={`${th} text-right`}>Entradas</th><th className={`${th} text-right`}>Días con uso</th>
                  <th className={`${th} text-right`}>Pantallas abiertas</th><th className={th}>La que más usa</th><th className={th}>Última vez</th>
                </tr></thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.user.id} onClick={() => setUserId(userId === p.user.id ? null : p.user.id)}
                      className={`cursor-pointer border-t border-zinc-100 dark:border-zinc-800 ${userId === p.user.id ? 'bg-indigo-50 dark:bg-indigo-950/50' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'} ${p.sessions || p.screens ? '' : 'text-zinc-400'}`}>
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
            <p className="mt-1 text-xs text-zinc-400">Pulsa una persona para ver su uso día a día. Una entrada es abrir la app o volver a ella tras 30 minutos sin mirarla.</p>
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Por día · {selected ? (selected.user.name || selected.user.login) : 'todo el equipo'}</h2>
              {selected && <button type="button" onClick={() => setUserId(null)} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Ver todo el equipo</button>}
            </div>
            {daily.length === 0 ? <p className="text-sm text-zinc-400">Sin uso en este periodo.</p> : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
                    <th className={th}>Día</th><th className={`${th} text-right`}>Entradas</th>
                    {screens.map((s) => <th key={s} className={`${th} text-right`}>{screenLabel(s)}</th>)}
                  </tr></thead>
                  <tbody>
                    {daily.map((d) => (
                      <tr key={d.day} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className={`${td} first-letter:uppercase`}>{formatDay(d.day, today)}</td>
                        <td className={`${td} text-right font-medium tabular-nums`}>{num(d.sessions)}</td>
                        {screens.map((s) => <td key={s} className={`${td} text-right tabular-nums`}>{num(d.screens[s] ?? 0)}</td>)}
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
