import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, CalendarDays, Check, ClipboardCheck, EyeOff, GripVertical, LayoutGrid, Lock, MessageSquare,
  MessagesSquare, NotebookPen, Paperclip, Plus, RotateCcw, Sun, Columns3, Video,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { routeHref } from '../../app/router';
import { QuickAdd } from '../../components/QuickAdd';
import { TaskList } from '../../components/TaskList';
import { Avatar } from '../../components/ui/Badges';
import { repo } from '../../data/services';
import { useSync } from '../../data/sync';
import { parseISODate, weekdayName } from '../../domain/dates';
import { reviewDue } from '../../domain/maintenance';
import { RALLY_COLUMNS } from '../../domain/rally';
import type { RecentEvent } from '../../domain/rallyActivity';
import { isHiddenRoute } from '../../domain/screens';
import { moveTodayCard, resolveTodayLayout, TODAY_CARDS, type TodayCardId } from '../../domain/todayLayout';
import { completedOn, isActive, myDayTasks, overdueTasks, tasksDueOn } from '../../domain/selectors';
import { TOPIC_TYPE_ID, type Task, type TodayCardLayout } from '../../domain/types';
import type { CalendarEvent } from '../../domain/ics';
import { stateOf } from '../../domain/workflows';
import { teamsWebUrl } from '../../domain/teams';
import { dropHighlight, useTaskDrop } from '../../hooks/useTaskDrop';
import { teamsLinkProps, useTeamsApp } from '../../hooks/useTeamsApp';
import { rallyBoardColumns } from '../board/Board';
import { useMeetings } from '../calendar/outlook';
import { CaptureGuide } from '../capture/CaptureGuide';
import { OverdueBlock } from '../maintenance/OverdueBlock';
import { StaleBlock } from '../maintenance/StaleBlock';
import { useRallyLookup } from '../rally/rallyStore';
import { ago, useRallyRecent } from '../today/rallyRecent';

/**
 * Hoy: la portada de Marea. Cabecera con el día y la captura, y una tarjeta por pantalla con lo de hoy (Mi día, Reuniones,
 * Para hablar, Rally, Notas y el Tablero). Cada persona las ordena, ensancha u oculta con «Personalizar»
 * (`settings.today_layout`). Las tarjetas de pantallas ocultas para esa cuenta (Ajustes → Pantallas) no salen.
 */

type CardId = TodayCardId;
const CARDS = TODAY_CARDS;

const SPAN = ['', 'xl:col-span-1', 'xl:col-span-2', 'xl:col-span-3'];
const MIME = 'application/x-marea-today-card';

export function TodayView() {
  const { tasks, today, settings, itemTypes } = useApp();
  const { user, hiddenScreens } = useSync();
  useWideLayout(true);
  const [editing, setEditing] = useState(false);
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const layout = resolveTodayLayout(settings.today_layout);
  const save = (next: TodayCardLayout[] | null) => void repo.updateSettings({ today_layout: next });

  const available = (id: string) => {
    const screen = CARDS.find((c) => c.id === id)?.screen;
    return !screen || !isHiddenRoute(screen, hiddenScreens);
  };
  const shown = layout.filter((c) => available(c.id));

  // Cifras de la cabecera.
  const pending = useMemo(() => {
    const ids = new Set<string>();
    const list: Task[] = [];
    for (const t of [...myDayTasks(tasks, today), ...tasksDueOn(tasks, today), ...overdueTasks(tasks, today)]) {
      if (t.type_id === TOPIC_TYPE_ID || ids.has(t.id)) continue;
      ids.add(t.id);
      list.push(t);
    }
    return list;
  }, [tasks, today]);
  const overdue = pending.filter((t) => t.due_date && t.due_date < today).length;
  const doing = tasks.filter((t) => isActive(t) && t.type_id !== TOPIC_TYPE_ID && stateOf(itemTypes, t).category === 'doing').length;
  const done = completedOn(tasks, today).length;
  const topics = tasks.filter((t) => isActive(t) && t.type_id === TOPIC_TYPE_ID).length;
  const meetings = useMeetings(today, today).get(today) ?? [];
  const d = parseISODate(today);
  const first = (user?.name ?? '').split(/\s+/)[0];

  const move = (from: string, to: string, after: boolean) => save(moveTodayCard(layout, from, to, after));
  const patch = (id: string, change: Partial<TodayCardLayout>) => save(layout.map((c) => (c.id === id ? { ...c, ...change } : c)));

  const dragProps = (id: string) => (editing ? {
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer.setData(MIME, id); e.dataTransfer.effectAllowed = 'move'; setDragging(id); },
    onDragEnd: () => { setDragging(null); setOver(null); },
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(MIME)) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: DragEvent) => {
      const from = e.dataTransfer.getData(MIME);
      if (!from) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      move(from, id, e.clientX - r.left > r.width / 2);
      setOver(null);
    },
  } : {});

  return (
    <div className="mx-auto max-w-[1400px]">
      <section className="rounded-2xl bg-[#1B2B4B] px-5 py-5 text-white sm:px-7 dark:bg-[#132038] dark:ring-1 dark:ring-white/10">
        <div className="flex items-center gap-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-[0.08em] text-[#F0997B] uppercase">
              {weekdayName(today, true)} {d.getDate()} de {d.toLocaleDateString('es-ES', { month: 'long' })}
            </p>
            <h1 className="mt-1 mb-3 text-2xl font-bold sm:text-3xl" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>
              {greeting()}{first ? `, ${first}` : ''}
            </h1>
            <div className="flex flex-wrap gap-1.5 text-[13px]">
              <Chip>{pending.length} para hoy</Chip>
              <Chip>{doing} en curso</Chip>
              {overdue > 0 && <Chip strong>{overdue} atrasadas</Chip>}
              {available('meetings') && <Chip>{meetings.length} {meetings.length === 1 ? 'reunión' : 'reuniones'}</Chip>}
              {available('topics') && topics > 0 && <Chip>{topics} {topics === 1 ? 'tema' : 'temas'} para hablar</Chip>}
            </div>
          </div>
          <Ring done={done} total={done + pending.length} />
        </div>
        <div className="mt-4 rounded-xl bg-white p-2 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 [&>div]:mb-0">
          <QuickAdd defaults={{ due_date: today }} seed={seed} placeholder="Añadir para hoy… (#proyecto @persona !1)" />
          <CaptureGuide onExample={(text) => setSeed({ text, n: Date.now() })} storageKey="today-capture-guide" defaultOpen={false} className="mt-2" />
        </div>
      </section>

      {reviewDue(settings.ui.last_review_on, today) && (
        <a href={routeHref({ view: 'review' })} className="mt-3 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-900/60">
          <ClipboardCheck className="size-4" /><span className="flex-1">Toca la <strong>revisión semanal</strong>: 10 minutos para dejarlo todo en orden.</span><span className="text-xs">Empezar →</span>
        </a>
      )}

      <div className="mt-4 mb-2 flex flex-wrap items-center gap-2">
        {editing && <span className="text-xs text-zinc-500">Arrastra las tarjetas por el asa · <Columns3 className="inline size-3.5" /> cambia el ancho · <EyeOff className="inline size-3.5" /> la oculta</span>}
        <span className="flex-1" />
        {editing && shown.filter((c) => c.hidden).map((c) => (
          <button key={c.id} type="button" onClick={() => patch(c.id, { hidden: false })}
            className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs text-violet-800 hover:bg-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:hover:bg-violet-900">
            <Plus className="size-3" />{labelOf(c.id)}
          </button>
        ))}
        {editing && (
          <button type="button" onClick={() => save(null)} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800">
            <RotateCcw className="size-3.5" />Restablecer
          </button>
        )}
        <button type="button" onClick={() => setEditing((e) => !e)}
          className={editing
            ? 'inline-flex items-center gap-1 rounded-md bg-[#1B2B4B] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#24375d] dark:bg-white dark:text-[#1B2B4B]'
            : 'inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'}>
          {editing ? <><Check className="size-3.5" />Listo</> : <><LayoutGrid className="size-3.5" />Personalizar</>}
        </button>
      </div>

      {/* Como un mosaico: cada tarjeta ocupa solo su alto (filas de 4 px) y `dense` rellena los huecos con las que caben. */}
      <div className="grid grid-flow-row-dense auto-rows-[4px] grid-cols-1 gap-x-3.5 lg:grid-cols-2 xl:grid-cols-3">
        {shown.filter((c) => !c.hidden).map((c) => (
          <Tile key={c.id} className={`min-w-0 ${SPAN[c.span] ?? ''} ${c.span >= 2 ? 'lg:col-span-2' : ''}`}>
          <div {...dragProps(c.id)}
            className={`${editing ? 'cursor-grab rounded-2xl outline-2 outline-offset-2 outline-dashed outline-violet-400' : ''} ${dragging === c.id ? 'opacity-40' : ''} ${over === c.id && dragging !== c.id ? 'rounded-2xl ring-4 ring-[#F0997B]' : ''}`}>
            {editing && (
              <div className="mb-1 flex items-center gap-1 px-1">
                <GripVertical className="size-4 text-violet-500" />
                <span className="flex-1 text-xs font-medium text-violet-700 dark:text-violet-300">{labelOf(c.id)}</span>
                <button type="button" title="Cambiar el ancho" onClick={() => patch(c.id, { span: c.span % 3 + 1 })}
                  className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900">
                  <Columns3 className="mr-0.5 inline size-3.5" />{c.span}/3
                </button>
                <button type="button" title="Ocultar" onClick={() => patch(c.id, { hidden: true })}
                  className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900">
                  <EyeOff className="size-3.5" />
                </button>
              </div>
            )}
            <div className={editing ? 'pointer-events-none select-none' : ''}><TodayCard id={c.id as CardId} meetings={meetings} /></div>
          </div>
          </Tile>
        ))}
      </div>

      <div className="mt-6"><StaleBlock /></div>
    </div>
  );
}

/** Una pieza del mosaico: mide su contenido y ocupa esas filas de 4 px (más el hueco entre tarjetas). */
const ROW = 4;
const GAP = 14;
function Tile({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(40);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setRows(Math.ceil((el.getBoundingClientRect().height + GAP) / ROW));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div className={className} style={{ gridRowEnd: `span ${rows}` }}><div ref={ref}>{children}</div></div>;
}

const labelOf = (id: string) => CARDS.find((c) => c.id === id)?.label ?? id;

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 14 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
}

const Chip = ({ children, strong }: { children: ReactNode; strong?: boolean }) => (
  <span className={`rounded-full px-3 py-0.5 ${strong ? 'bg-[#D85A30] text-white' : 'bg-white/12 text-white'}`}>{children}</span>
);

function Ring({ done, total }: { done: number; total: number }) {
  const r = 32;
  const len = 2 * Math.PI * r;
  const part = total ? Math.min(1, done / total) : 0;
  return (
    <svg width="96" height="96" viewBox="0 0 78 78" className="hidden shrink-0 sm:block" role="img" aria-label={`${done} de ${total} hechas hoy`}>
      <circle cx="39" cy="39" r={r} fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="8" />
      <circle cx="39" cy="39" r={r} fill="none" stroke="#F0997B" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${len * part} ${len}`} transform="rotate(-90 39 39)" />
      <text x="39" y="39" textAnchor="middle" fill="#fff" fontSize="17" fontWeight="700" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>{done}/{total}</text>
      <text x="39" y="52" textAnchor="middle" fill="rgba(255,255,255,.7)" fontSize="9">hechas hoy</text>
    </svg>
  );
}

function Card({ icon, tone, title, link, children, onDropTasks }: {
  icon: ReactNode; tone: string; title: string; link?: { href: string; label: string }; children: ReactNode; onDropTasks?: (ids: string[]) => void;
}) {
  const { over, dropProps } = useTaskDrop(onDropTasks);
  return (
    <section className={`@container rounded-2xl border border-zinc-200 bg-white px-4 py-3.5 dark:border-zinc-700 dark:bg-zinc-900 ${over ? dropHighlight : ''}`} {...dropProps}>
      <header className="mb-2.5 flex items-center gap-2.5">
        <span className={`flex size-7 items-center justify-center rounded-lg ${tone}`}>{icon}</span>
        <h2 className="text-[15px] font-medium" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>{title}</h2>
        {link && <a href={link.href} className="ml-auto text-xs text-zinc-500 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200">{link.label} →</a>}
      </header>
      {children}
    </section>
  );
}

const Sub = ({ children }: { children: ReactNode }) => <p className="mt-1 px-2 text-xs text-zinc-500 dark:text-zinc-400">{children}</p>;

function TodayCard({ id, meetings }: { id: CardId; meetings: CalendarEvent[] }) {
  switch (id) {
    case 'myday': return <MyDayCard />;
    case 'meetings': return <MeetingsCard meetings={meetings} />;
    case 'topics': return <TopicsCard />;
    case 'rally': return <RallyCard />;
    case 'notes': return <NotesCard />;
    case 'board': return <BoardCard />;
  }
}

/** Mi día: lo elegido para hoy, lo que vence hoy, las atrasadas (con sus botones) y lo que tienes en curso. */
function MyDayCard() {
  const { tasks, today, projectMap, editTask, itemTypes } = useApp();
  const notTopic = (t: Task) => t.type_id !== TOPIC_TYPE_ID;
  const myDay = myDayTasks(tasks, today).filter(notTopic);
  const due = tasksDueOn(tasks, today).filter((t) => notTopic(t) && t.my_day !== today);
  const listed = new Set([...myDay, ...due].map((t) => t.id));
  const doing = tasks.filter((t) => isActive(t) && notTopic(t) && !listed.has(t.id) && stateOf(itemTypes, t).category === 'doing');
  const list = { today, projects: projectMap, onEdit: editTask };
  return (
    <Card icon={<Sun className="size-4" />} tone="bg-[#FAECE7] text-[#993C1D] dark:bg-[#4A1B0C] dark:text-[#F5C4B3]" title="Mi día"
      onDropTasks={(ids) => void repo.batch(ids.length === 1 ? 'Añadida a Mi día' : `${ids.length} añadidas a Mi día`, async () => {
        for (const taskId of ids) await repo.updateTask(taskId, { my_day: today });
      })}>
      <div className="[&_section]:mb-3">
        <OverdueBlock />
      </div>
      <Sub>Para hoy · {myDay.length + due.length}</Sub>
      <TaskList {...list} tasks={[...myDay, ...due]} hideDate empty="Nada para hoy. Elige con ☀, la tecla A o arrastrando aquí." />
      {doing.length > 0 && (
        <>
          <Sub>En curso · {doing.length}</Sub>
          <TaskList {...list} tasks={doing} />
        </>
      )}
    </Card>
  );
}

const nowHm = () => {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
};

/** Reuniones de hoy en línea de tiempo: las pasadas atenuadas y la de ahora resaltada con «Unirse». */
function MeetingsCard({ meetings }: { meetings: CalendarEvent[] }) {
  const [teamsApp] = useTeamsApp();
  const [now, setNow] = useState(nowHm);
  useEffect(() => {
    const t = setInterval(() => setNow(nowHm()), 60_000);
    return () => clearInterval(t);
  }, []);
  const list = [...meetings].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  return (
    <Card icon={<CalendarDays className="size-4" />} tone="bg-[#E6F1FB] text-[#0C447C] dark:bg-[#0C2A4A] dark:text-[#B5D4F4]" title="Reuniones"
      link={{ href: routeHref({ view: 'calendar' }), label: 'Calendario' }}>
      {!list.length ? (
        <p className="px-1 py-2 text-sm text-zinc-400">No tienes reuniones hoy.</p>
      ) : (
        <ol className="ml-2 border-l-2 border-zinc-200 pl-4 dark:border-zinc-700">
          {list.map((m) => {
            const end = m.end ?? m.time;
            const past = !!m.time && !!end && end <= now;
            const live = !!m.time && m.time <= now && !past;
            const join = m.url && (m.calendar ? teamsLinkProps(teamsWebUrl(m.url), false) : teamsLinkProps(m.url, teamsApp));
            return (
              <li key={m.uid} className="relative pb-3 last:pb-0">
                <span className={`absolute top-1 -left-[23px] size-3 rounded-full ${live ? 'bg-[#D85A30] ring-4 ring-[#FAECE7] dark:ring-[#4A1B0C]' : past ? 'bg-zinc-300 dark:bg-zinc-600' : m.calendar ? 'bg-[#1D9E75]' : 'bg-[#378ADD]'}`} />
                <p className={`text-xs ${live ? 'text-[#993C1D] dark:text-[#F0997B]' : 'text-zinc-500'}`}>
                  {live ? 'Ahora · ' : ''}{m.time ? `${m.time}${m.end ? ` – ${m.end}` : ''}` : 'Todo el día'}{m.calendar ? ` · ${m.calendar}` : ''}{past ? ' · hecha' : ''}
                </p>
                <p className={`flex items-center gap-2 text-sm ${past ? 'text-zinc-400' : ''} ${live ? 'font-semibold' : ''}`}>
                  <span className="min-w-0 truncate">{m.title}</span>
                  {join && !past && (
                    <a {...join} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#1B2B4B] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#24375d] dark:bg-white dark:text-[#1B2B4B]">
                      <Video className="size-3" />Unirse
                    </a>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** Para hablar: los temas pendientes, por persona. */
function TopicsCard() {
  const { tasks, editTask } = useApp();
  const byPerson = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!isActive(t) || t.type_id !== TOPIC_TYPE_ID) continue;
    const who = t.people[0] ?? '';
    byPerson.set(who, [...(byPerson.get(who) ?? []), t]);
  }
  const rows = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return (
    <Card icon={<MessagesSquare className="size-4" />} tone="bg-[#FBEAF0] text-[#72243E] dark:bg-[#4B1528] dark:text-[#F4C0D1]" title="Para hablar"
      link={{ href: routeHref({ view: 'people' }), label: 'Grupos' }}>
      {!rows.length && <p className="px-1 py-2 text-sm text-zinc-400">Ningún tema pendiente.</p>}
      <ul>
        {rows.slice(0, 6).map(([who, list]) => (
          <li key={who} className="flex items-start gap-2.5 border-t border-zinc-100 py-2 first:border-0 dark:border-zinc-800">
            {who ? <Avatar name={who} size={28} /> : <span className="size-7 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700" />}
            <div className="min-w-0 flex-1">
              {who ? <a href={routeHref({ view: 'person', name: who })} className="text-sm font-medium hover:underline">{who}</a> : <span className="text-sm text-zinc-500">Sin persona</span>}
              <div className="flex flex-wrap gap-x-2 text-xs text-zinc-500">
                {list.slice(0, 3).map((t) => (
                  <button key={t.id} type="button" onClick={() => editTask(t)} className="max-w-full truncate text-left hover:text-zinc-800 hover:underline dark:hover:text-zinc-200">{t.title}</button>
                ))}
                {list.length > 3 && <span>y {list.length - 3} más</span>}
              </div>
            </div>
            <span className="rounded-full bg-[#FAECE7] px-2 py-0.5 text-[11px] text-[#712B13] dark:bg-[#4A1B0C] dark:text-[#F5C4B3]">{list.length}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const EVENT_ICON: Record<RecentEvent['kind'], { icon: ReactNode; tone: string }> = {
  comment: { icon: <MessageSquare className="size-3.5" />, tone: 'bg-[#FAEEDA] text-[#633806] dark:bg-[#412402] dark:text-[#FAC775]' },
  flow: { icon: <ArrowRight className="size-3.5" />, tone: 'bg-[#E6F1FB] text-[#0C447C] dark:bg-[#042C53] dark:text-[#B5D4F4]' },
  create: { icon: <Plus className="size-3.5" />, tone: 'bg-[#EAF3DE] text-[#27500A] dark:bg-[#173404] dark:text-[#C0DD97]' },
  attachment: { icon: <Paperclip className="size-3.5" />, tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  blocked: { icon: <Lock className="size-3.5" />, tone: 'bg-[#FCEBEB] text-[#791F1F] dark:bg-[#501313] dark:text-[#F7C1C1]' },
};

function eventText(e: RecentEvent): ReactNode {
  const id = <span className="text-indigo-600 dark:text-indigo-300">{e.id}</span>;
  const who = e.user ? <b className="font-medium">{e.user}</b> : 'Alguien';
  switch (e.kind) {
    case 'comment': return <>{who} comentó en {id}</>;
    case 'attachment': return <>{who} subió {e.to || 'un archivo'} a {id}</>;
    case 'flow': return <>{id} → {e.to || 'otra columna'}{e.user ? <> · {e.user}</> : null}</>;
    case 'blocked': return e.to === 'true' ? <>{id} bloqueada{e.user ? <> · {e.user}</> : null}</> : <>{id} desbloqueada{e.user ? <> · {e.user}</> : null}</>;
    case 'create': return <>{e.id.startsWith('TS') ? 'Nuevo' : 'Nueva'} {e.id.replace(/\d+$/, '')} {id} para ti{e.user ? <> · de {e.user}</> : null}</>;
  }
}

/** Rally: lo que otras personas han hecho en tus elementos en los últimos 3 días. */
function RallyCard() {
  const { tasks, editTask } = useApp();
  const state = useRallyRecent(tasks, true);
  const linked = useMemo(() => new Map(tasks.filter((t) => t.external_id).map((t) => [t.external_id!.replace(/-/g, '').toUpperCase(), t])), [tasks]);
  return (
    <Card icon={<Activity className="size-4" />} tone="bg-[#EEEDFE] text-[#3C3489] dark:bg-[#26215C] dark:text-[#CECBF6]" title="Rally · últimos cambios en lo tuyo"
      link={{ href: routeHref({ view: 'rally' }), label: 'Abrir Rally' }}>
      {state.status === 'loading' && !state.events.length && <p className="px-1 py-2 text-sm text-zinc-400">Mirando Rally…</p>}
      {state.status === 'off' && <p className="px-1 py-2 text-sm text-zinc-500">Conecta Rally en su pantalla para ver aquí los cambios de tus elementos.</p>}
      {state.status === 'error' && !state.events.length && <p className="px-1 py-2 text-sm text-zinc-500">No se ha podido leer Rally ahora. {state.error}</p>}
      {state.status === 'ok' && !state.events.length && <p className="px-1 py-2 text-sm text-zinc-400">Nadie ha tocado tus elementos en los últimos 3 días.</p>}
      <ul className="grid gap-x-6 @lg:grid-cols-2">
        {state.events.slice(0, 10).map((e, i) => {
          const task = linked.get(e.id);
          return (
            <li key={`${e.kind}-${e.id}-${e.at}-${i}`} className="flex items-center gap-2.5 border-t border-zinc-100 py-2 dark:border-zinc-800 @lg:[&:nth-child(-n+2)]:border-0 first:border-0">
              <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${EVENT_ICON[e.kind].tone}`}>{EVENT_ICON[e.kind].icon}</span>
              <button type="button" title={e.name} onClick={() => (task ? editTask(task) : (location.hash = routeHref({ view: 'rally' })))}
                className="min-w-0 flex-1 truncate text-left text-sm hover:underline">{eventText(e)}</button>
              <span className="shrink-0 text-xs text-zinc-500">{ago(e.at)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Últimas notas editadas. */
function NotesCard() {
  const { notes, projectMap } = useApp();
  const recent = [...notes].filter((n) => !n.deleted_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  return (
    <Card icon={<NotebookPen className="size-4" />} tone="bg-[#FAEEDA] text-[#633806] dark:bg-[#412402] dark:text-[#FAC775]" title="Últimas notas"
      link={{ href: routeHref({ view: 'notes' }), label: 'Notas' }}>
      {!recent.length && <p className="px-1 py-2 text-sm text-zinc-400">Aún no hay notas.</p>}
      <ul>
        {recent.map((n) => {
          const project = n.project_id ? projectMap.get(n.project_id) : undefined;
          return (
            <li key={n.id} className="border-t border-zinc-100 first:border-0 dark:border-zinc-800">
              <a href={routeHref({ view: 'notes', id: n.id })} className="flex items-center gap-2.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: project?.color ?? '#B4B2A9' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{n.title || 'Sin título'}</span>
                  <span className="block truncate text-xs text-zinc-500">{project ? `#${project.name}` : n.kind === 'meeting' ? 'Acta' : 'Sin sección'}</span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500">{ago(n.updated_at)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Tu tablero: cuántas tareas hay en cada columna (las mismas que el Tablero «Como en Rally»). */
function BoardCard() {
  const { tasks, today, itemTypes } = useApp();
  const rallyOf = useRallyLookup();
  const counts = useMemo(() => {
    const { columnOf } = rallyBoardColumns(tasks, itemTypes, today, rallyOf);
    const out = new Map<string, number>();
    for (const col of columnOf.values()) out.set(col, (out.get(col) ?? 0) + 1);
    return out;
  }, [tasks, itemTypes, today, rallyOf]);
  return (
    <Card icon={<LayoutGrid className="size-4" />} tone="bg-[#E1F5EE] text-[#085041] dark:bg-[#04342C] dark:text-[#9FE1CB]" title="Tu tablero"
      link={{ href: routeHref({ view: 'board' }), label: 'Ir al Tablero' }}>
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-4 @3xl:grid-cols-7">
        {RALLY_COLUMNS.map((c) => (
          <a key={c.name} href={routeHref({ view: 'board' })}
            className="rounded-xl border-t-4 bg-zinc-50 px-2 py-2.5 text-center hover:bg-zinc-100 dark:bg-zinc-800/60 dark:hover:bg-zinc-800"
            style={{ borderTopColor: c.color }}>
            <span className="block text-xs text-zinc-500">{c.name}</span>
            <span className="block text-2xl font-bold" style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}>{counts.get(c.name) ?? 0}</span>
          </a>
        ))}
      </div>
    </Card>
  );
}
