import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, CalendarDays, CalendarCheck, CalendarRange, CheckSquare, ChevronDown, ChevronLeft,
  ChevronRight, Clock, GitCompareArrows, Grid3x3, LayoutGrid, LogIn, MessageSquare, MousePointerClick, NotebookPen, Plug, RefreshCw, User, UserRound, Users,
  type LucideIcon,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { sync, useSync } from '../../data/sync';
import { addDays, formatDay } from '../../domain/dates';
import { dailyUsage, screenLabel, summarizeUsers, usedScreens, type UsageReport, type UserSummary } from '../../domain/usage';
import { activitySeries, adoption, heatLevel, percentOf, screenRanking, usersByDay, type DayPoint, type ScreenRank } from '../../domain/usageDashboard';
import {
  autoGranularity, bucketSeries, delta, isoWeekValue, MAX_DAYS_BACK, mondayOfIsoWeek, monthRange, PRESETS, previousRange, rangeDays, rangeLabel,
  resolveRange, shiftRange, type Bucket, type Granularity, type UsageRange,
} from '../../domain/usageRange';
import { Popover } from '../../components/ui/Popover';
import { formatSeconds, screenKpis, type Kpi, type KpiPart, type ScreenKpis } from '../../domain/usageKpis';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ViewHeader } from '../views/ViewHeader';
import { RallyToolTab } from './RallyToolTab';

type Tab = 'summary' | 'screens' | 'people' | 'daily' | 'rally';
const TABS: { id: Tab; label: string; icon: LucideIcon; team?: boolean }[] = [
  { id: 'summary', label: 'Resumen', icon: BarChart3 },
  { id: 'screens', label: 'Por pantalla', icon: LayoutGrid },
  { id: 'people', label: 'Personas', icon: Users, team: true },
  { id: 'daily', label: 'Día a día', icon: Grid3x3 },
  { id: 'rally', label: 'Rally: herramienta o Rally', icon: GitCompareArrows, team: true },
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
/** Color de cada pantalla (variable `--scr`, en index.css): las ocho principales tienen el suyo y el resto, gris. */
const scr = (id: string) => `scr scr-${id}`;
/** Intensidad del color de una pantalla en el mapa de calor (0 = nada). */
const SCR_HEAT = ['', 'bg-(--scr)/15', 'bg-(--scr)/35', 'bg-(--scr)/65 text-white', 'bg-(--scr) text-white'];
/** Franja de color arriba de cada bloque del Resumen. */
const ACCENT = {
  indigo: 'border-t-4 border-t-indigo-500 dark:border-t-indigo-400',
  emerald: 'border-t-4 border-t-emerald-500 dark:border-t-emerald-400',
  sky: 'border-t-4 border-t-sky-500 dark:border-t-sky-400',
  amber: 'border-t-4 border-t-amber-500 dark:border-t-amber-400',
  violet: 'border-t-4 border-t-violet-500 dark:border-t-violet-400',
};
type Tone = keyof typeof ACCENT;
const TONE: Record<Tone, { chip: string; bar: string }> = {
  indigo: { chip: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300', bar: 'bg-indigo-500 dark:bg-indigo-400' },
  emerald: { chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300', bar: 'bg-emerald-500 dark:bg-emerald-400' },
  sky: { chip: 'bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300', bar: 'bg-sky-500 dark:bg-sky-400' },
  amber: { chip: 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300', bar: 'bg-amber-500 dark:bg-amber-400' },
  violet: { chip: 'bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300', bar: 'bg-violet-500 dark:bg-violet-400' },
};
/** Entradas (índigo): más oscuro = más uso. */
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
  const [range, setRange] = usePersistentState<UsageRange>('analytics-range', { preset: '30d' });
  const [tab, setTab] = usePersistentState<Tab>('analytics-tab', 'summary');
  const [userId, setUserId] = useState<string | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [prevReport, setPrevReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const { from, to } = resolveRange(range, today);
  const days = rangeDays(from, to);
  const prev = previousRange(from, to);
  useWideLayout(true);

  // El periodo elegido y el anterior de la misma duración (para comparar); si el anterior falla, se ve sin comparación.
  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [r, p] = await Promise.all([sync().adminUsage(from, to), sync().adminUsage(prev.from, prev.to).catch(() => null)]);
      setReport(r);
      setPrevReport(p);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [from, to, prev.from, prev.to]);
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  const people = useMemo(() => (report ? summarizeUsers(report) : []), [report]);
  const kpis = useMemo(() => (report ? screenKpis(report, userId ? [userId] : null) : []), [report, userId]);
  const series = useMemo(() => (report ? activitySeries(report, from, to, userId) : []), [report, from, to, userId]);
  const dayUsers = useMemo(() => (report ? usersByDay(report, userId) : new Map<string, Set<string>>()), [report, userId]);
  const before = useMemo(() => {
    if (!prevReport) return null;
    const ps = summarizeUsers(prevReport).filter((p) => !userId || p.user.id === userId);
    const s = activitySeries(prevReport, prev.from, prev.to, userId);
    return {
      sessions: ps.reduce((n, p) => n + p.sessions, 0),
      screens: ps.reduce((n, p) => n + p.screens, 0),
      active: ps.filter((p) => p.sessions || p.screens).length,
      activeDays: s.filter((d) => d.sessions || d.people).length,
      label: rangeLabel(prev.from, prev.to),
    };
  }, [prevReport, prev.from, prev.to, userId]);
  const ranking = useMemo(() => (report ? screenRanking(report, userId) : []), [report, userId]);
  const daily = useMemo(() => (report ? dailyUsage(report, from, to, userId).filter((d) => d.sessions || Object.keys(d.screens).length) : []), [report, from, to, userId]);

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
          <PeriodPicker range={range} from={from} to={to} today={today} onChange={setRange} />
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
            <Summary people={people} selected={selected} days={days} series={series} dayUsers={dayUsers} before={before} ranking={ranking} kpis={kpis}
              onPerson={setUserId} onScreen={goScreen} />
          )}
          {current === 'screens' && <ScreensTab kpis={kpis} team={team} />}
          {current === 'people' && team && <PeopleTab people={people} report={report} from={from} today={to} days={days} onPerson={setUserId} />}
          {current === 'daily' && <DailyTab daily={daily} today={today} />}
          {current === 'rally' && team && <RallyToolTab from={from} to={to} users={report.users} />}
        </div>
      )}
    </>
  );
}

// ───────────────────────────── Resumen ─────────────────────────────

type Before = { sessions: number; screens: number; active: number; activeDays: number; label: string } | null;

function Summary({ people, selected, days, series, dayUsers, before, ranking, kpis, onPerson, onScreen }: {
  people: UserSummary[]; selected: UserSummary | null; days: number; series: DayPoint[]; dayUsers: Map<string, Set<string>>; before: Before;
  ranking: ScreenRank[]; kpis: ScreenKpis[];
  onPerson: (id: string) => void; onScreen: (id: string) => void;
}) {
  const scope = selected ? [selected] : people;
  const sessions = scope.reduce((n, p) => n + p.sessions, 0);
  const screens = scope.reduce((n, p) => n + p.screens, 0);
  const ad = adoption(people);
  const activeDays = series.filter((d) => d.sessions || d.people).length;
  const [granPref, setGranPref] = usePersistentState<Granularity | 'auto'>('analytics-granularity', 'auto');
  const gran = granPref === 'auto' ? autoGranularity(days) : granPref;
  const buckets = useMemo(() => bucketSeries(series, dayUsers, gran), [series, dayUsers, gran]);
  const vs = (now: number, k: keyof NonNullable<Before>) => (before ? { pct: delta(now, before[k] as number), was: before[k] as number, label: before.label } : undefined);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        {selected ? (
          <Tile tone="emerald" icon={Clock} label="Última vez" value={when(selected.last)} small />
        ) : (
          <Tile tone="emerald" icon={Users} label="Personas activas" value={String(ad.active)} extra={` de ${ad.total}`}
            bar={pct(ad.active, ad.total)} hint={`${pct(ad.active, ad.total)} % de las cuentas han entrado`} vs={vs(ad.active, 'active')} />
        )}
        <Tile tone="indigo" icon={LogIn} label="Entradas en la app" value={String(sessions)} vs={vs(sessions, 'sessions')}
          hint={selected ? `${activeDays ? (sessions / activeDays).toFixed(1) : '0'} por día con uso` : `${ad.active ? (sessions / ad.active).toFixed(1) : '0'} por persona activa`} />
        <Tile tone="sky" icon={MousePointerClick} label="Pantallas abiertas" value={String(screens)} vs={vs(screens, 'screens')}
          hint={sessions ? `${(screens / sessions).toFixed(1)} por entrada` : undefined} />
        <Tile tone="violet" icon={CalendarDays} label="Días con uso" value={String(activeDays)} extra={` de ${days}`} bar={pct(activeDays, days)} vs={vs(activeDays, 'activeDays')}
          hint={selected ? 'días que ha entrado' : 'días que alguien ha entrado'} />
      </div>

      <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <div className={`${card} ${ACCENT.indigo} col-span-2 max-lg:col-span-1`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className={cardTitle}>Evolución · entradas por {gran === 'day' ? 'día' : gran === 'week' ? 'semana' : 'mes'}</h3>
            <Segmented>
              {(['day', 'week', 'month'] as const).map((g) => (
                <SegButton key={g} active={gran === g} onClick={() => setGranPref(g === autoGranularity(days) ? 'auto' : g)}>
                  {g === 'day' ? 'Día' : g === 'week' ? 'Semana' : 'Mes'}
                </SegButton>
              ))}
            </Segmented>
          </div>
          <ActivityChart buckets={buckets} team={!selected} gran={gran} />
        </div>
        {selected
          ? <PersonCard p={selected} ranking={ranking} />
          : <AdoptionCard ad={ad} onPerson={onPerson} />}
      </div>

      <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <div className={`${card} ${ACCENT.sky} col-span-2 max-lg:col-span-1`}>
          <h3 className={`${cardTitle} mb-3`}>Pantallas más usadas</h3>
          <ScreenBars ranking={ranking} team={!selected} onScreen={onScreen} />
        </div>
        <div className={`${card} ${ACCENT.amber}`}>
          <h3 className={`${cardTitle} mb-3`}>Lo más destacado</h3>
          <Highlights kpis={kpis} onScreen={onScreen} />
        </div>
      </div>
    </div>
  );
}

function ActivityChart({ buckets, team, gran }: { buckets: Bucket[]; team: boolean; gran: Granularity }) {
  const max = Math.max(1, ...buckets.map((d) => d.sessions));
  const total = buckets.reduce((n, d) => n + d.sessions, 0);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 12));
  const unit = gran === 'day' ? 'un día' : gran === 'week' ? 'una semana' : 'un mes';
  if (!total) return <Empty text="Sin entradas en este periodo." />;
  return (
    <div>
      <div className="flex h-44 items-end gap-[2px] border-b border-zinc-200 dark:border-zinc-700" role="img"
        aria-label={`Entradas: ${total} en total, máximo ${max} en ${unit}`}>
        {buckets.map((d) => (
          <div key={d.key} className="group relative flex h-full flex-1 items-end justify-center">
            <div className={`w-full ${gran === 'day' ? 'max-w-6' : 'max-w-14'} rounded-t-[4px] bg-indigo-500 transition-colors group-hover:bg-indigo-700 dark:bg-indigo-400 dark:group-hover:bg-indigo-300`}
              style={{ height: `${(d.sessions / max) * 100}%`, minHeight: d.sessions ? 3 : 0 }} />
            <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md bg-zinc-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
              <b className="capitalize">{gran === 'day' ? `${weekday(d.from)} ${shortDay(d.from)}` : d.from === d.to ? shortDay(d.from) : `${d.label} · ${shortDay(d.from)} – ${shortDay(d.to)}`}</b><br />
              {d.sessions} entradas{team && <> · {d.people} {d.people === 1 ? 'persona' : 'personas'}</>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-zinc-400">
        {buckets.map((d, i) => (
          <span key={d.key} className="flex-1 overflow-hidden text-center whitespace-nowrap">{(buckets.length - 1 - i) % labelEvery === 0 ? d.label : ''}</span>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Máximo <b className="text-zinc-700 dark:text-zinc-200">{max}</b> entradas en {unit} · <b className="text-zinc-700 dark:text-zinc-200">{total}</b> en total ·
        pasa el ratón por una barra para ver el detalle
      </p>
    </div>
  );
}

function AdoptionCard({ ad, onPerson }: { ad: ReturnType<typeof adoption>; onPerson: (id: string) => void }) {
  const idle = ad.idle.length;
  const parts = [
    { label: 'Han entrado', n: ad.active, cls: 'bg-emerald-500 dark:bg-emerald-400' },
    { label: 'Sin entrar', n: idle, cls: 'bg-amber-400 dark:bg-amber-500' },
    { label: 'Desactivadas', n: ad.disabled, cls: 'bg-zinc-300 dark:bg-zinc-700' },
  ].filter((p) => p.n > 0);
  return (
    <div className={`${card} ${ACCENT.emerald}`}>
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
    <div className={`${card} ${ACCENT.emerald}`}>
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
              className={`${scr(r.screen)} group grid w-full grid-cols-[8rem_1fr_4.5rem_4.5rem] items-center gap-x-3 rounded text-left text-sm max-sm:grid-cols-[6rem_1fr_3.5rem]`}>
              <span className="flex min-w-0 items-center gap-1.5"><span className="size-2.5 shrink-0 rounded-sm bg-(--scr)" /><span className="truncate group-hover:underline">{screenLabel(r.screen)}</span></span>
              <span className="flex items-center gap-2">
                <span className="flex h-4 min-w-0 flex-1 overflow-hidden">
                  <span className="flex gap-[2px] rounded-r-[4px]" style={{ width: `${(r.visits / max) * 100}%` }}>
                    {r.quality > 0 && <span className="h-full rounded-l-[2px] bg-(--scr)" style={{ width: `${(r.quality / r.visits) * 100}%` }} />}
                    {r.visits > r.quality && <span className="h-full flex-1 rounded-r-[4px] bg-(--scr)/35" />}
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
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-zinc-600 dark:bg-zinc-300" />Tramo intenso: visitas de calidad (15 s o alguna acción)</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-zinc-600/35 dark:bg-zinc-300/35" />Tramo claro: resto de visitas</span>
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
              <span className={`${scr(h.screen)} grid size-8 shrink-0 place-items-center rounded-lg bg-(--scr)/15 text-(--scr)`}><h.icon className="size-4" /></span>
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
            className={`${scr(k.id)} inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs text-zinc-600 hover:border-(--scr) dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300`}>
            <span className="size-2 rounded-full bg-(--scr)" />{k.title}{k.visits ? <span className="ml-1 text-zinc-400 tabular-nums">{k.visits.visits}</span> : null}
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
    <section id={`kpi-${block.id}`} className={`${card} ${scr(block.id)} scroll-mt-14 border-t-4 border-t-(--scr)`}>
      <h3 className="mb-3 flex items-center justify-between gap-2 font-semibold">
        <span className="flex items-center gap-2"><span className="size-3 rounded-full bg-(--scr)" />{block.title}</span>
        {v && <span className="rounded-full bg-(--scr)/15 px-2 py-0.5 text-xs font-medium tabular-nums">{v.visits} {v.visits === 1 ? 'visita' : 'visitas'}</span>}
      </h3>
      {v && (
        <div className="mb-3 grid grid-cols-3 gap-2 max-sm:grid-cols-1">
          <div className="rounded-lg bg-(--scr)/10 p-2">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">De calidad</div>
            <div className="text-lg font-semibold tabular-nums">{q} %</div>
            <Bar value={q} fill="bg-(--scr)" />
          </div>
          <div className="rounded-lg bg-(--scr)/10 p-2">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Tiempo medio</div>
            <div className="text-lg font-semibold tabular-nums">{formatSeconds(v.avgSeconds)}</div>
          </div>
          <div className="rounded-lg bg-(--scr)/10 p-2">
            {team ? <>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Personas de calidad</div>
              <div className="text-lg font-semibold tabular-nums">{v.qualityPeople}<span className="text-sm font-normal text-zinc-400"> de {v.people}</span></div>
              <Bar value={pct(v.qualityPeople, v.people)} fill="bg-(--scr)" />
            </> : <>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Ha entrado</div>
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
      {p !== null && <div className="mt-1"><Bar value={p} fill="bg-(--scr)" /></div>}
      {kpi.hint && <div className="mt-0.5 text-xs text-zinc-400">{kpi.hint}</div>}
      {kpi.people && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500" title="Personas que lo hacen">
          <UserRound className="size-3 shrink-0" />
          <span className="flex-1"><Bar value={pct(kpi.people.n, kpi.people.of)} thin fill="bg-(--scr)/60" /></span>
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
    <ul className="mt-1.5 space-y-1 rounded-lg bg-(--scr)/8 p-2">
      {[...parts].sort((a, b) => b.value - a.value).map((p) => (
        <li key={p.label} className="grid grid-cols-[minmax(0,10rem)_1fr_2.5rem] items-center gap-2 text-xs">
          <span className="truncate text-zinc-600 dark:text-zinc-300" title={p.label}>{p.label}</span>
          <span className="h-2"><span className="block h-full rounded-r-[4px] bg-(--scr)/75" style={{ width: `${(p.value / max) * 100}%` }} /></span>
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
            <th className={th}>La que más usa</th><th className={th}>Últimos 14 días del periodo</th><th className={th}>Última vez</th>
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
            {screens.map((sc) => (
              <th key={sc} className={`${th} ${scr(sc)} text-center`}>
                <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-(--scr)" />{screenLabel(sc)}</span>
              </th>
            ))}
          </tr></thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.day}>
                <td className={`${td} first-letter:uppercase`}>{formatDay(d.day, today)}</td>
                <Cell value={d.sessions} cls={HEAT[heatLevel(d.sessions, maxSessions)]} title={`${d.sessions} entradas`} strong />
                {screens.map((sc) => {
                  const n = d.screens[sc] ?? 0;
                  const lv = heatLevel(n, maxCell);
                  return <Cell key={sc} value={n} cls={lv ? `${scr(sc)} ${SCR_HEAT[lv]}` : ''} title={`${screenLabel(sc)}: ${n} visitas`} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, cls, title, strong }: { value: number; cls: string; title: string; strong?: boolean }) {
  return (
    <td title={title} className={`min-w-12 rounded-[4px] px-2 py-1.5 text-center tabular-nums ${strong ? 'font-semibold' : ''} ${cls || 'bg-zinc-50 text-zinc-300 dark:bg-zinc-800/40 dark:text-zinc-600'}`}>
      {value || '·'}
    </td>
  );
}

// ───────────────────────────── Piezas ─────────────────────────────

type Vs = { pct: number | null; was: number; label: string };

function Tile({ tone, icon: Icon, label, value, extra, hint, bar, small, vs }: {
  tone: Tone; icon: LucideIcon; label: string; value: string; extra?: string; hint?: string; bar?: number; small?: boolean; vs?: Vs;
}) {
  return (
    <div className={`${card} ${ACCENT[tone]}`}>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className={`grid size-7 place-items-center rounded-lg ${TONE[tone].chip}`}><Icon className="size-4" /></span>
        {label}
      </div>
      <div className={`mt-2 ${small ? 'text-lg' : 'text-3xl'} font-semibold tabular-nums`}>
        {value}{extra && <span className="text-base font-normal text-zinc-400">{extra}</span>}
      </div>
      {bar !== undefined && <div className="mt-2"><Bar value={bar} fill={TONE[tone].bar} /></div>}
      {hint && <div className="mt-1 text-xs text-zinc-400">{hint}</div>}
      {vs && <Compare vs={vs} />}
    </div>
  );
}

/** Comparación con el periodo anterior: sube (verde), baja (rojo) o igual. */
function Compare({ vs }: { vs: Vs }) {
  const up = (vs.pct ?? 0) > 0;
  const down = (vs.pct ?? 0) < 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="mt-2 flex items-center gap-1.5 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800" title={`Periodo anterior: ${vs.label}`}>
      {vs.pct === null
        ? <span className="text-zinc-400">Antes: {vs.was}</span>
        : <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium ${up
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
            : down ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}`}>
            {(up || down) && <Icon className="size-3" />}{up ? '+' : ''}{vs.pct} %
          </span>}
      <span className="truncate text-zinc-400">vs. periodo anterior ({vs.was})</span>
    </div>
  );
}

function Bar({ value, thin, fill = 'bg-indigo-500 dark:bg-indigo-400' }: { value: number; thin?: boolean; fill?: string }) {
  return (
    <div className={`${thin ? 'h-1' : 'h-1.5'} w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800`}
      role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
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

// ───────────────────────────── Periodo ─────────────────────────────

/**
 * Elegir el periodo: atajos (días, semanas, meses), una semana o un mes concretos, o de un día a otro. Las flechas mueven el
 * periodo hacia atrás o hacia delante con la misma duración (semana a semana, mes a mes…).
 */
function PeriodPicker({ range, from, to, today, onChange }: {
  range: UsageRange; from: string; to: string; today: string; onChange: (r: UsageRange) => void;
}) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  useEffect(() => { setA(from); setB(to); }, [from, to]);
  const min = addDays(today, -MAX_DAYS_BACK);
  const preset = 'preset' in range ? PRESETS.find((p) => p.id === range.preset) : undefined;
  const back = shiftRange(from, to, -1);
  const fwd = shiftRange(from, to, 1);
  const canBack = back.to >= min;
  const canFwd = to < today;
  const arrow = 'grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-900 dark:hover:text-zinc-100';
  const input = 'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-900';
  const groups = [...new Set(PRESETS.map((p) => p.group))];

  return (
    <div className="inline-flex items-center rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
      <button type="button" className={arrow} disabled={!canBack} onClick={() => onChange(back)} title="Periodo anterior" aria-label="Periodo anterior">
        <ChevronLeft className="size-4" />
      </button>
      <Popover width="w-[22rem]" align="right" trigger={(toggle, open) => (
        <button type="button" onClick={toggle} aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 text-sm font-medium shadow-sm dark:bg-zinc-900">
          <CalendarRange className="size-4 text-indigo-500" />
          <span className="max-w-64 truncate">{preset ? preset.label : rangeLabel(from, to)}</span>
          <ChevronDown className="size-3.5 text-zinc-400" />
        </button>
      )}>
        {(close) => (
          <div className="space-y-3 p-3 text-sm">
            <p className="text-xs text-zinc-500">{rangeLabel(from, to)} · {rangeDays(from, to)} días</p>
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">{g}</p>
                <div className="flex flex-wrap gap-1">
                  {PRESETS.filter((p) => p.group === g).map((p) => (
                    <button key={p.id} type="button" onClick={() => { onChange({ preset: p.id }); close(); }}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${preset?.id === p.id
                        ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                        : 'border-zinc-200 hover:border-indigo-300 dark:border-zinc-700'}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <label className="text-xs text-zinc-500">Una semana
                <input type="week" className={`${input} mt-1 w-full`} value={isoWeekValue(from)}
                  onChange={(e) => {
                    const m = mondayOfIsoWeek(e.target.value);
                    if (m && m <= today) { onChange({ from: m, to: addDays(m, 6) }); close(); }
                  }} />
              </label>
              <label className="text-xs text-zinc-500">Un mes
                <input type="month" className={`${input} mt-1 w-full`} value={from.slice(0, 7)} max={today.slice(0, 7)}
                  onChange={(e) => { const r = monthRange(e.target.value); if (r && r.from <= today) { onChange(r); close(); } }} />
              </label>
            </div>
            <form className="border-t border-zinc-100 pt-3 dark:border-zinc-800"
              onSubmit={(e) => { e.preventDefault(); if (a && b) { onChange(a <= b ? { from: a, to: b } : { from: b, to: a }); close(); } }}>
              <p className="mb-1 text-xs text-zinc-500">De un día a otro</p>
              <div className="flex items-center gap-2">
                <input type="date" className={`${input} min-w-0 flex-1`} value={a} min={min} max={today} onChange={(e) => setA(e.target.value)} aria-label="Desde" />
                <span className="text-zinc-400">–</span>
                <input type="date" className={`${input} min-w-0 flex-1`} value={b} min={min} max={today} onChange={(e) => setB(e.target.value)} aria-label="Hasta" />
              </div>
              <button type="submit" className="mt-2 w-full rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Aplicar</button>
              <p className="mt-1.5 text-[11px] text-zinc-400">Hay datos desde que se activó la analítica, como mucho de los últimos {MAX_DAYS_BACK} días.</p>
            </form>
          </div>
        )}
      </Popover>
      <button type="button" className={arrow} disabled={!canFwd} onClick={() => onChange(fwd)} title="Periodo siguiente" aria-label="Periodo siguiente">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
