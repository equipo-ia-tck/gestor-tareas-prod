import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, BarChart3, CalendarDays, CalendarCheck, CheckSquare, Clock, Grid3x3, LayoutGrid, LogIn, MessageSquare, MousePointerClick,
  NotebookPen, Plug, RefreshCw, User, UserRound, Users, type LucideIcon,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { sync, useSync } from '../../data/sync';
import { addDays, formatDay } from '../../domain/dates';
import { dailyUsage, screenLabel, summarizeUsers, usedScreens, type UsageReport, type UserSummary } from '../../domain/usage';
import { activitySeries, adoption, heatLevel, percentOf, screenRanking, type DayPoint, type ScreenRank } from '../../domain/usageDashboard';
import { formatSeconds, screenKpis, type Kpi, type KpiPart, type ScreenKpis } from '../../domain/usageKpis';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ViewHeader } from '../views/ViewHeader';

const PERIODS = [{ days: 7, label: '7 días' }, { days: 30, label: '30 días' }, { days: 90, label: '90 días' }];
type Tab = 'summary' | 'screens' | 'people' | 'daily';
const TABS: { id: Tab; label: string; icon: LucideIcon; team?: boolean }[] = [
  { id: 'summary', label: 'Resumen', icon: BarChart3 },
  { id: 'screens', label: 'Por pantalla', icon: LayoutGrid },
  { id: 'people', label: 'Personas', icon: Users, team: true },
  { id: 'daily', label: 'Día a día', icon: Grid3x3 },
];

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { weekday: 'short' });
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const nameOf = (p: UserSummary) => p.user.name || p.user.login;

const card = 'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700/80 dark:bg-zinc-900';
const cardTitle = 'text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400';
const th = 'px-3 py-2 text-left text-xs font-medium text-zinc-500 whitespace-nowrap';
const td = 'px-3 py-2 whitespace-nowrap';
/** Un solo tono (índigo) para todo: más oscuro = más uso. */
const HEAT = [
  '',
  'bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-indigo-200 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100',
  'bg-indigo-400 text-white dark:bg-indigo-700 dark:text-white',
  'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-white',
];

/**
 * Más → Analítica (solo administradores), en formato panel: Resumen (cifras, actividad diaria, adopción, pantallas más
 * usadas y lo más destacado), Por pantalla (los KPIs de cada una), Personas (equipo) y Día a día (mapa de calor).
 * Vista de equipo o de una persona y periodo de 7, 30 o 90 días.
 */
export function UsageView() {
  const { isAdmin } = useSync();
  const { today } = useApp();
  const [days, setDays] = usePersistentState('analytics-period', 30);
  const [tab, setTab] = usePersistentState<Tab>('analytics-tab', 'summary');
  const [userId, setUserId] = useState<string | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const from = addDays(today, -(days - 1));
  useWideLayout(true);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try { setReport(await sync().adminUsage(from, today)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [from, today]);
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  const people = useMemo(() => (report ? summarizeUsers(report) : []), [report]);
  const kpis = useMemo(() => (report ? screenKpis(report, userId ? [userId] : null) : []), [report, userId]);
  const series = useMemo(() => (report ? activitySeries(report, from, today, userId) : []), [report, from, today, userId]);
  const ranking = useMemo(() => (report ? screenRanking(report, userId) : []), [report, userId]);
  const daily = useMemo(() => (report ? dailyUsage(report, from, today, userId).filter((d) => d.sessions || Object.keys(d.screens).length) : []), [report, from, today, userId]);

  // Al pulsar algo del Resumen se abre «Por pantalla» en su tarjeta.
  useEffect(() => {
    if (!jump || tab !== 'screens') return;
    const t = setTimeout(() => { document.getElementById(`kpi-${jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setJump(null); }, 50);
    return () => clearTimeout(t);
  }, [jump, tab]);
  const goScreen = (id: string) => { setJump(id); setTab('screens'); };

  if (!isAdmin) return <><ViewHeader title="Analítica" /><p className="text-sm text-zinc-500">Solo los administradores ven la analítica de uso.</p></>;

  const selected = people.find((p) => p.user.id === userId) ?? null;
  const team = !selected;
  const current = TABS.find((t) => t.id === tab && (team || !t.team))?.id ?? 'summary';
  const missingKpis = !!report && report.users.length > 0 && !report.users[0].snapshot;

  return (
    <>
      <ViewHeader title="Analítica" subtitle={selected ? `Uso de ${nameOf(selected)}` : 'Uso de todo el equipo'}
        actions={<>
          <Segmented>
            <SegButton active={team} onClick={() => setUserId(null)}><Users className="size-4" />Equipo</SegButton>
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
          </Segmented>
          <Segmented>
            {PERIODS.map((p) => <SegButton key={p.days} active={days === p.days} onClick={() => setDays(p.days)}>{p.label}</SegButton>)}
          </Segmented>
          <button type="button" onClick={() => void load()} title="Actualizar"
            className="flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />Actualizar
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
        <div className="-mx-1 rounded-2xl bg-zinc-50 p-3 sm:p-4 dark:bg-zinc-950/60">
          <nav className="mb-4 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800" aria-label="Apartados de la analítica">
            {TABS.filter((t) => team || !t.team).map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={current === t.id ? 'page' : undefined}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${current === t.id
                  ? 'border-indigo-600 font-medium text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
                <t.icon className="size-4" />{t.label}
              </button>
            ))}
          </nav>

          {current === 'summary' && (
            <Summary people={people} selected={selected} days={days} series={series} ranking={ranking} kpis={kpis}
              onPerson={setUserId} onScreen={goScreen} />
          )}
          {current === 'screens' && <ScreensTab kpis={kpis} team={team} />}
          {current === 'people' && team && <PeopleTab people={people} report={report} from={from} today={today} days={days} onPerson={setUserId} />}
          {current === 'daily' && <DailyTab daily={daily} today={today} />}
        </div>
      )}
    </>
  );
}

// ───────────────────────────── Resumen ─────────────────────────────

function Summary({ people, selected, days, series, ranking, kpis, onPerson, onScreen }: {
  people: UserSummary[]; selected: UserSummary | null; days: number; series: DayPoint[]; ranking: ScreenRank[]; kpis: ScreenKpis[];
  onPerson: (id: string) => void; onScreen: (id: string) => void;
}) {
  const scope = selected ? [selected] : people;
  const sessions = scope.reduce((n, p) => n + p.sessions, 0);
  const screens = scope.reduce((n, p) => n + p.screens, 0);
  const ad = adoption(people);
  const activeDays = series.filter((d) => d.sessions || d.people).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        {selected ? (
          <Tile icon={Clock} label="Última vez" value={when(selected.last)} small />
        ) : (
          <Tile icon={Users} label="Personas activas" value={String(ad.active)} extra={` de ${ad.total}`}
            bar={pct(ad.active, ad.total)} hint={`${pct(ad.active, ad.total)} % de las cuentas han entrado`} />
        )}
        <Tile icon={LogIn} label="Entradas en la app" value={String(sessions)}
          hint={selected ? `${activeDays ? (sessions / activeDays).toFixed(1) : '0'} por día con uso` : `${ad.active ? (sessions / ad.active).toFixed(1) : '0'} por persona activa`} />
        <Tile icon={MousePointerClick} label="Pantallas abiertas" value={String(screens)}
          hint={sessions ? `${(screens / sessions).toFixed(1)} por entrada` : undefined} />
        <Tile icon={CalendarDays} label="Días con uso" value={String(activeDays)} extra={` de ${days}`} bar={pct(activeDays, days)}
          hint={selected ? 'días que ha entrado' : 'días que alguien ha entrado'} />
      </div>

      <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <div className={`${card} col-span-2 max-lg:col-span-1`}>
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className={cardTitle}>Actividad diaria · entradas</h3>
            <span className="text-xs text-zinc-400">Pasa el ratón por una barra para ver el día</span>
          </div>
          <ActivityChart series={series} team={!selected} />
        </div>
        {selected
          ? <PersonCard p={selected} ranking={ranking} />
          : <AdoptionCard ad={ad} onPerson={onPerson} />}
      </div>

      <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <div className={`${card} col-span-2 max-lg:col-span-1`}>
          <h3 className={`${cardTitle} mb-3`}>Pantallas más usadas</h3>
          <ScreenBars ranking={ranking} team={!selected} onScreen={onScreen} />
        </div>
        <div className={card}>
          <h3 className={`${cardTitle} mb-3`}>Lo más destacado</h3>
          <Highlights kpis={kpis} onScreen={onScreen} />
        </div>
      </div>
    </div>
  );
}

function ActivityChart({ series, team }: { series: DayPoint[]; team: boolean }) {
  const max = Math.max(1, ...series.map((d) => d.sessions));
  const total = series.reduce((n, d) => n + d.sessions, 0);
  const labelEvery = series.length > 31 ? 14 : series.length > 10 ? 7 : 1;
  if (!total) return <Empty text="Sin entradas en este periodo." />;
  return (
    <div>
      <div className="flex h-40 items-end gap-[2px] border-b border-zinc-200 dark:border-zinc-700" role="img"
        aria-label={`Entradas por día: ${total} en total, máximo ${max} en un día`}>
        {series.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end justify-center">
            <div className="w-full max-w-6 rounded-t-[4px] bg-indigo-500 transition-colors group-hover:bg-indigo-700 dark:bg-indigo-400 dark:group-hover:bg-indigo-300"
              style={{ height: `${(d.sessions / max) * 100}%`, minHeight: d.sessions ? 3 : 0 }} />
            <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md bg-zinc-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
              <b className="capitalize">{weekday(d.day)} {shortDay(d.day)}</b><br />
              {d.sessions} entradas{team && <> · {d.people} {d.people === 1 ? 'persona' : 'personas'}</>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-zinc-400">
        {series.map((d, i) => (
          <span key={d.day} className="flex-1 text-center whitespace-nowrap">{(series.length - 1 - i) % labelEvery === 0 ? shortDay(d.day) : ''}</span>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">Máximo <b className="text-zinc-700 dark:text-zinc-200">{max}</b> entradas en un día · <b className="text-zinc-700 dark:text-zinc-200">{total}</b> en total</p>
    </div>
  );
}

function AdoptionCard({ ad, onPerson }: { ad: ReturnType<typeof adoption>; onPerson: (id: string) => void }) {
  const idle = ad.idle.length;
  const parts = [
    { label: 'Han entrado', n: ad.active, cls: 'bg-indigo-600 dark:bg-indigo-400' },
    { label: 'Sin entrar', n: idle, cls: 'bg-indigo-200 dark:bg-indigo-900' },
    { label: 'Desactivadas', n: ad.disabled, cls: 'bg-zinc-300 dark:bg-zinc-700' },
  ].filter((p) => p.n > 0);
  return (
    <div className={card}>
      <h3 className={`${cardTitle} mb-3`}>Adopción del equipo</h3>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums">{pct(ad.active, ad.total)} %</span>
        <span className="text-sm text-zinc-500">{ad.active} de {ad.total} cuentas han entrado</span>
      </div>
      <div className="mt-3 flex h-3 gap-[2px] overflow-hidden rounded-full">
        {parts.map((p) => <div key={p.label} className={p.cls} style={{ width: `${(p.n / Math.max(1, ad.total)) * 100}%` }} title={`${p.label}: ${p.n}`} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
        {parts.map((p) => <span key={p.label} className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${p.cls}`} />{p.label} <b>{p.n}</b></span>)}
      </div>
      <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <p className="mb-1.5 text-xs font-medium text-zinc-500">Tienen cuenta y no han entrado en el periodo</p>
        {!idle && <p className="text-sm text-emerald-700 dark:text-emerald-400">Todo el equipo ha entrado.</p>}
        <ul className="max-h-40 space-y-0.5 overflow-y-auto">
          {ad.idle.map((p) => (
            <li key={p.user.id}>
              <button type="button" onClick={() => onPerson(p.user.id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
                <Avatar name={nameOf(p)} muted /><span className="truncate">{nameOf(p)}</span>
                <span className="ml-auto truncate text-xs text-zinc-400">{p.user.login}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PersonCard({ p, ranking }: { p: UserSummary; ranking: ScreenRank[] }) {
  return (
    <div className={card}>
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={nameOf(p)} large />
        <div className="min-w-0">
          <div className="truncate font-semibold">{nameOf(p)}</div>
          <div className="truncate text-xs text-zinc-500">{p.user.login}{p.user.disabled && ' · desactivada'}</div>
        </div>
      </div>
      <dl className="space-y-2 text-sm">
        <Row k="Pantalla que más usa" v={p.top ? screenLabel(p.top) : '—'} />
        <Row k="Pantallas distintas" v={String(ranking.length)} />
        <Row k="Días con uso" v={String(p.activeDays)} />
        <Row k="Última vez" v={when(p.last)} />
      </dl>
    </div>
  );
}

function ScreenBars({ ranking, team, onScreen }: { ranking: ScreenRank[]; team: boolean; onScreen: (id: string) => void }) {
  if (!ranking.length) return <Empty text="Ninguna pantalla abierta en este periodo." />;
  const max = Math.max(1, ...ranking.map((r) => r.visits));
  return (
    <div>
      <div className="mb-2 grid grid-cols-[8rem_1fr_4.5rem_4.5rem] gap-x-3 text-[11px] text-zinc-400 max-sm:grid-cols-[6rem_1fr_3.5rem]">
        <span>Pantalla</span><span>Visitas</span><span className="text-right">Tiempo medio</span>
        <span className="text-right max-sm:hidden">{team ? 'Personas' : 'De calidad'}</span>
      </div>
      <ul className="space-y-1.5">
        {ranking.map((r) => (
          <li key={r.screen}>
            <button type="button" onClick={() => onScreen(r.screen)} title={`${screenLabel(r.screen)}: ${r.visits} visitas, ${r.quality} de calidad (${pct(r.quality, r.visits)} %)`}
              className="group grid w-full grid-cols-[8rem_1fr_4.5rem_4.5rem] items-center gap-x-3 rounded text-left text-sm max-sm:grid-cols-[6rem_1fr_3.5rem]">
              <span className="truncate group-hover:underline">{screenLabel(r.screen)}</span>
              <span className="flex items-center gap-2">
                <span className="flex h-4 min-w-0 flex-1 overflow-hidden">
                  <span className="flex gap-[2px] rounded-r-[4px]" style={{ width: `${(r.visits / max) * 100}%` }}>
                    {r.quality > 0 && <span className="h-full rounded-l-[2px] bg-indigo-600 dark:bg-indigo-400" style={{ width: `${(r.quality / r.visits) * 100}%` }} />}
                    {r.visits > r.quality && <span className="h-full flex-1 rounded-r-[4px] bg-indigo-200 dark:bg-indigo-900" />}
                  </span>
                </span>
                <span className="w-8 shrink-0 text-right font-medium tabular-nums">{r.visits}</span>
              </span>
              <span className="text-right text-zinc-500 tabular-nums">{formatSeconds(r.avgSeconds)}</span>
              <span className="text-right text-zinc-500 tabular-nums max-sm:hidden">{team ? r.people : `${pct(r.quality, r.visits)} %`}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-indigo-600 dark:bg-indigo-400" />Visitas de calidad (15 s o alguna acción)</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-indigo-200 dark:bg-indigo-900" />Resto de visitas</span>
      </div>
    </div>
  );
}

const HIGHLIGHTS: { screen: string; label: string; title: string; icon: LucideIcon }[] = [
  { screen: 'inbox', label: 'Tareas creadas con la herramienta', title: 'Tareas creadas', icon: CheckSquare },
  { screen: 'board', label: 'Discusiones publicadas por la app', title: 'Discusiones en Rally', icon: MessageSquare },
  { screen: 'board', label: 'Movimientos enviados a Rally', title: 'Movimientos a Rally', icon: Activity },
  { screen: 'calendar', label: 'Se unen a reuniones desde la herramienta', title: 'Se unen a reuniones', icon: CalendarCheck },
  { screen: 'notes', label: 'Notas creadas', title: 'Notas creadas', icon: NotebookPen },
  { screen: 'rally', label: 'Tienen Rally conectado', title: 'Rally conectado', icon: Plug },
];

function Highlights({ kpis, onScreen }: { kpis: ScreenKpis[]; onScreen: (id: string) => void }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {HIGHLIGHTS.map((h) => {
        const k = kpis.find((b) => b.id === h.screen)?.kpis.find((x) => x.label === h.label);
        if (!k) return null;
        return (
          <li key={h.label}>
            <button type="button" onClick={() => onScreen(h.screen)} className="group flex w-full items-center gap-3 py-2 text-left">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><h.icon className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm group-hover:underline">{h.title}</span>
                {k.people && <span className="block text-xs text-zinc-400">{k.people.n} de {k.people.of} personas</span>}
              </span>
              <span className="text-lg font-semibold tabular-nums">{k.value}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── Por pantalla ─────────────────────────────

function ScreensTab({ kpis, team }: { kpis: ScreenKpis[]; team: boolean }) {
  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-3 flex flex-wrap gap-1.5 bg-zinc-50/95 px-1 py-2 backdrop-blur dark:bg-zinc-950/90">
        {kpis.map((k) => (
          <a key={k.id} href={`#kpi-${k.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`kpi-${k.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            className="rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs text-zinc-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-700 dark:hover:text-indigo-300">
            {k.title}{k.visits ? <span className="ml-1 text-zinc-400 tabular-nums">{k.visits.visits}</span> : null}
          </a>
        ))}
      </div>
      <div className="columns-2 gap-3 max-lg:columns-1 [&>*]:mb-3 [&>*]:break-inside-avoid">
        {kpis.map((k) => <ScreenCard key={k.id} block={k} team={team} />)}
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        Una visita es «de calidad» si la pantalla está a la vista al menos 15 segundos o si se hace algo en ella. Las cifras de
        tareas, notas, grupos y fichas salen de los datos de cada persona en este momento; el resto, de lo que se ha hecho en el periodo.
      </p>
    </div>
  );
}

/** Tarjeta de una pantalla: sus visitas (cuántas, de calidad, tiempo medio, personas) y sus KPIs. */
export function ScreenCard({ block, team }: { block: ScreenKpis; team: boolean }) {
  const v = block.visits;
  const q = v ? pct(v.quality, v.visits) : 0;
  return (
    <section id={`kpi-${block.id}`} className={`${card} scroll-mt-14`}>
      <h3 className="mb-3 flex items-baseline justify-between gap-2 font-semibold">
        {block.title}
        {v && <span className="text-xs font-normal text-zinc-400">{v.visits} {v.visits === 1 ? 'visita' : 'visitas'}</span>}
      </h3>
      {v && (
        <div className="mb-3 grid grid-cols-3 gap-2 max-sm:grid-cols-1">
          <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
            <div className="text-[11px] text-zinc-500">De calidad</div>
            <div className="text-lg font-semibold tabular-nums">{q} %</div>
            <Bar value={q} />
          </div>
          <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
            <div className="text-[11px] text-zinc-500">Tiempo medio</div>
            <div className="text-lg font-semibold tabular-nums">{formatSeconds(v.avgSeconds)}</div>
          </div>
          <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
            {team ? <>
              <div className="text-[11px] text-zinc-500">Personas de calidad</div>
              <div className="text-lg font-semibold tabular-nums">{v.qualityPeople}<span className="text-sm font-normal text-zinc-400"> de {v.people}</span></div>
              <Bar value={pct(v.qualityPeople, v.people)} />
            </> : <>
              <div className="text-[11px] text-zinc-500">Ha entrado</div>
              <div className="text-lg font-semibold">{v.visits ? 'Sí' : 'No'}</div>
            </>}
          </div>
        </div>
      )}
      {block.kpis.length > 0 && <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">{block.kpis.map((k) => <KpiRow key={k.label} kpi={k} />)}</ul>}
      {!v?.visits && block.kpis.length === 0 && <p className="text-xs text-zinc-400">Sin uso en este periodo.</p>}
    </section>
  );
}

function KpiRow({ kpi }: { kpi: Kpi }) {
  const p = percentOf(kpi.value);
  return (
    <li className="py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">{kpi.label}</span>
        <span className="shrink-0 text-base font-semibold tabular-nums">{kpi.value}</span>
      </div>
      {p !== null && <div className="mt-1"><Bar value={p} /></div>}
      {kpi.hint && <div className="mt-0.5 text-xs text-zinc-400">{kpi.hint}</div>}
      {kpi.people && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500" title="Personas que lo hacen">
          <UserRound className="size-3 shrink-0" />
          <span className="flex-1"><Bar value={pct(kpi.people.n, kpi.people.of)} thin /></span>
          <span className="shrink-0 tabular-nums">{kpi.people.n} de {kpi.people.of} personas</span>
        </div>
      )}
      {kpi.parts && kpi.parts.length > 0 && <Parts parts={kpi.parts} />}
    </li>
  );
}

/** Desglose de un KPI en barras horizontales (de más a menos). */
function Parts({ parts }: { parts: KpiPart[] }) {
  const max = Math.max(1, ...parts.map((p) => p.value));
  return (
    <ul className="mt-1.5 space-y-1 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/50">
      {[...parts].sort((a, b) => b.value - a.value).map((p) => (
        <li key={p.label} className="grid grid-cols-[minmax(0,10rem)_1fr_2.5rem] items-center gap-2 text-xs">
          <span className="truncate text-zinc-600 dark:text-zinc-300" title={p.label}>{p.label}</span>
          <span className="h-2"><span className="block h-full rounded-r-[4px] bg-indigo-400 dark:bg-indigo-500" style={{ width: `${(p.value / max) * 100}%` }} /></span>
          <span className="text-right font-medium tabular-nums">{p.value}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── Personas ─────────────────────────────

function PeopleTab({ people, report, from, today, days, onPerson }: {
  people: UserSummary[]; report: UsageReport; from: string; today: string; days: number; onPerson: (id: string) => void;
}) {
  const maxSessions = Math.max(1, ...people.map((p) => p.sessions));
  const stripFrom = addDays(today, -13) > from ? addDays(today, -13) : from;
  const strips = useMemo(() => new Map(people.map((p) => [p.user.id, activitySeries(report, stripFrom, today, p.user.id)])), [people, report, stripFrom, today]);
  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-800/60"><tr>
            <th className={th}>Persona</th><th className={th}>Estado</th><th className={`${th} min-w-40`}>Entradas</th>
            <th className={`${th} min-w-32`}>Días con uso</th><th className={`${th} text-right`}>Pantallas</th>
            <th className={th}>La que más usa</th><th className={th}>Últimos 14 días</th><th className={th}>Última vez</th>
          </tr></thead>
          <tbody>
            {people.map((p) => {
              const used = p.sessions > 0 || p.screens > 0;
              return (
                <tr key={p.user.id} onClick={() => onPerson(p.user.id)} title="Ver su analítica"
                  className="cursor-pointer border-t border-zinc-100 hover:bg-indigo-50/40 dark:border-zinc-800 dark:hover:bg-indigo-950/30">
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <Avatar name={nameOf(p)} muted={!used} />
                      <div className="min-w-0">
                        <div className={`font-medium ${used ? '' : 'text-zinc-400'}`}>{nameOf(p)}</div>
                        <div className="text-xs text-zinc-400">{p.user.login}</div>
                      </div>
                    </div>
                  </td>
                  <td className={td}><Status used={used} disabled={p.user.disabled} /></td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <span className="flex-1"><Bar value={pct(p.sessions, maxSessions)} /></span>
                      <span className="w-8 text-right font-medium tabular-nums">{p.sessions}</span>
                    </div>
                  </td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <span className="flex-1"><Bar value={pct(p.activeDays, days)} /></span>
                      <span className="w-12 text-right tabular-nums text-zinc-500">{p.activeDays}/{days}</span>
                    </div>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{p.screens}</td>
                  <td className={td}>{p.top ? screenLabel(p.top) : <span className="text-zinc-300 dark:text-zinc-600">—</span>}</td>
                  <td className={td}>
                    <div className="flex gap-[2px]">
                      {(strips.get(p.user.id) ?? []).map((d) => (
                        <span key={d.day} title={`${shortDay(d.day)}: ${d.sessions} entradas`}
                          className={`size-3 rounded-[3px] ${d.people ? HEAT[heatLevel(Math.max(1, d.sessions), 4)] : 'bg-zinc-100 dark:bg-zinc-800'}`} />
                      ))}
                    </div>
                  </td>
                  <td className={`${td} text-zinc-500`}>{when(p.last)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-zinc-100 px-3 py-2 text-xs text-zinc-400 dark:border-zinc-800">
        Pulsa una persona para ver su analítica. Una entrada es abrir la app o volver a ella tras 30 minutos sin mirarla.
      </p>
    </div>
  );
}

function Status({ used, disabled }: { used: boolean; disabled: boolean }) {
  const [label, dot] = disabled ? ['Desactivada', 'bg-zinc-400'] : used ? ['Activa', 'bg-emerald-500'] : ['Sin entrar', 'bg-amber-500'];
  return <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><span className={`size-2 rounded-full ${dot}`} />{label}</span>;
}

// ───────────────────────────── Día a día ─────────────────────────────

function DailyTab({ daily, today }: { daily: ReturnType<typeof dailyUsage>; today: string }) {
  const screens = usedScreens(daily);
  if (!daily.length) return <div className={card}><Empty text="Sin uso en este periodo." /></div>;
  const maxCell = Math.max(1, ...daily.flatMap((d) => Object.values(d.screens)));
  const maxSessions = Math.max(1, ...daily.map((d) => d.sessions));
  return (
    <div className={`${card} overflow-hidden p-0`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <h3 className={cardTitle}>Visitas a cada pantalla, día a día</h3>
        <span className="flex items-center gap-1 text-xs text-zinc-500">
          Menos {HEAT.slice(1).map((c, i) => <span key={i} className={`size-3 rounded-[3px] ${c}`} />)} Más
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px] text-sm">
          <thead><tr>
            <th className={th}>Día</th><th className={`${th} text-center`}>Entradas</th>
            {screens.map((sc) => <th key={sc} className={`${th} text-center`}>{screenLabel(sc)}</th>)}
          </tr></thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.day}>
                <td className={`${td} first-letter:uppercase`}>{formatDay(d.day, today)}</td>
                <Cell value={d.sessions} level={heatLevel(d.sessions, maxSessions)} title={`${d.sessions} entradas`} strong />
                {screens.map((sc) => {
                  const n = d.screens[sc] ?? 0;
                  return <Cell key={sc} value={n} level={heatLevel(n, maxCell)} title={`${screenLabel(sc)}: ${n} visitas`} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, level, title, strong }: { value: number; level: number; title: string; strong?: boolean }) {
  return (
    <td title={title} className={`min-w-12 rounded-[4px] px-2 py-1.5 text-center tabular-nums ${strong ? 'font-semibold' : ''} ${level ? HEAT[level] : 'bg-zinc-50 text-zinc-300 dark:bg-zinc-800/40 dark:text-zinc-600'}`}>
      {value || '·'}
    </td>
  );
}

// ───────────────────────────── Piezas ─────────────────────────────

function Tile({ icon: Icon, label, value, extra, hint, bar, small }: {
  icon: LucideIcon; label: string; value: string; extra?: string; hint?: string; bar?: number; small?: boolean;
}) {
  return (
    <div className={card}>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="grid size-7 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><Icon className="size-4" /></span>
        {label}
      </div>
      <div className={`mt-2 ${small ? 'text-lg' : 'text-3xl'} font-semibold tabular-nums`}>
        {value}{extra && <span className="text-base font-normal text-zinc-400">{extra}</span>}
      </div>
      {bar !== undefined && <div className="mt-2"><Bar value={bar} /></div>}
      {hint && <div className="mt-1 text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

function Bar({ value, thin }: { value: number; thin?: boolean }) {
  return (
    <div className={`${thin ? 'h-1' : 'h-1.5'} w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800`}
      role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function Avatar({ name, muted, large }: { name: string; muted?: boolean; large?: boolean }) {
  const initials = name.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return (
    <span className={`grid shrink-0 place-items-center rounded-full font-medium ${large ? 'size-10 text-sm' : 'size-7 text-[11px]'} ${muted
      ? 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
      : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'}`}>{initials}</span>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-2"><dt className="text-zinc-500">{k}</dt><dd className="truncate text-right font-medium">{v}</dd></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-zinc-400">{text}</p>;
}

function Segmented({ children }: { children: ReactNode }) {
  return <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">{children}</div>;
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${active ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
      {children}
    </button>
  );
}
