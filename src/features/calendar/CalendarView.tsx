import { useEffect, useState, type ReactNode } from 'react';
import { ImprovingBadge } from '../../components/ui/ImprovingBadge';
import { track, trackState } from '../usage/track';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, PanelLeft, Plus, RefreshCw, Rocket } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { routeHref } from '../../app/router';
import { MenuItem, Popover } from '../../components/ui/Popover';
import { TypeBadge } from '../../components/ui/Badges';
import { addDays, addMonths, isWorkday, mondayOf, monthGrid, parseISODate } from '../../domain/dates';
import type { CalendarEvent } from '../../domain/ics';
import { sortTasks, tasksDueOn } from '../../domain/selectors';
import type { ISODate, Task } from '../../domain/types';
import { findType } from '../../domain/workflows';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useTaskActions } from '../../hooks/useTaskActions';
import { dropHighlight, setDraggedTasks, useTaskDrop } from '../../hooks/useTaskDrop';
import { useCommandCenter } from '../command/CommandCenter';
import { WeekView } from '../views/WeekView';
import { MeetingItem } from './Meetings';
import { EXTRA_COLOR, hasCalendar, hasExtra, loadOutlook, useMeetings, useOutlook } from './outlook';
import { WeekAgenda } from './WeekAgenda';
import { looksCapped, OUTLOOK_CAP } from '../../domain/outlookEvents';

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const LETTERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MAX_VISIBLE = 4;

type Mode = 'day' | 'workweek' | 'week' | 'month' | 'list';
const MODES: { id: Mode; label: string }[] = [
  { id: 'day', label: 'Día' },
  { id: 'workweek', label: 'Semana laboral' },
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mes' },
  { id: 'list', label: 'Lista de la semana' },
];

const monthName = (iso: ISODate, opts: Intl.DateTimeFormatOptions = { month: 'long' }) => parseISODate(iso).toLocaleDateString('es-ES', opts);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Días que se ven en las vistas por horas. */
function visibleDays(mode: Mode, cursor: ISODate): ISODate[] {
  if (mode === 'day') return [cursor];
  const monday = mondayOf(cursor);
  return Array.from({ length: mode === 'workweek' ? 5 : 7 }, (_, i) => addDays(monday, i));
}

/** "26–30 de octubre de 2026", "29 de septiembre – 3 de octubre de 2026", "Jueves, 29 de octubre de 2026"… */
function rangeLabel(mode: Mode, cursor: ISODate, days: ISODate[]): string {
  const d = parseISODate(cursor);
  if (mode === 'month') return capital(d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
  if (mode === 'day') return capital(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  const a = parseISODate(days[0]);
  const b = parseISODate(days[days.length - 1]);
  if (a.getFullYear() !== b.getFullYear()) {
    return `${a.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })} – ${b.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()} de ${monthName(days[0])} – ${b.getDate()} de ${monthName(days[days.length - 1])} de ${b.getFullYear()}`;
  return `${a.getDate()}–${b.getDate()} de ${monthName(days[0])} de ${b.getFullYear()}`;
}

/**
 * Calendario al estilo Teams: a la izquierda, un minicalendario y "Mis calendarios" (reuniones de Outlook, tareas,
 * releases); arriba, Hoy, flechas, el rango y la vista (Día, Semana laboral, Semana, Mes o la lista de la semana).
 * Ocupa toda la ventana: solo hace scroll la agenda. Arrastrar una tarea a otro día cambia su fecha.
 */
export function CalendarView({ initial }: { initial?: 'week' | 'month' }) {
  useWideLayout('full');
  const { tasks, today } = useApp();
  const outlook = useOutlook();
  const { open } = useCommandCenter();
  const [mode, setMode] = usePersistentState<Mode>('calendar-mode', 'workweek');
  // Si se llega desde #/week o G S, se abre la semana laboral.
  useEffect(() => { if (initial) setMode(initial === 'week' ? 'workweek' : 'month'); }, [initial]); // setMode guarda en localStorage
  const [cursor, setCursor] = useState<ISODate>(today);
  const [sidebar, setSidebar] = usePersistentState('calendar-sidebar', true);
  const [showMeetings, setShowMeetings] = usePersistentState('calendar-meetings', true);
  const [showTasks, setShowTasks] = usePersistentState('calendar-tasks', true);
  // Analítica: si tiene a la vista las tareas en el calendario (la última elección cuenta).
  useEffect(() => { trackState('calendar-tasks', '', showTasks ? 1 : 0); }, [showTasks]);
  const [showDone, setShowDone] = usePersistentState('calendar-done', false);
  // Aviso de tope del flujo: sale cada vez que se entra al Calendario mientras siga pasando.
  const [capNotice, setCapNotice] = useState(true);

  const days = visibleDays(mode, cursor);
  const grid = monthGrid(cursor);
  const [from, to] = mode === 'month' ? [grid[0][0], grid[grid.length - 1][6]] : [days[0], days[days.length - 1]];
  const [showExtra, setShowExtra] = usePersistentState('calendar-extra', true);
  const allMeetings = useMeetings(from, to);
  // Cada calendario con su interruptor: Outlook (sin `calendar`) y el otro (La Caixa…).
  const meetings = new Map<ISODate, CalendarEvent[]>();
  for (const [day, list] of allMeetings) {
    const shown = list.filter((e) => (e.calendar ? showExtra : showMeetings));
    if (shown.length) meetings.set(day, shown);
  }

  // Tareas de cada día: las pendientes con esa fecha y, si se pide, las completadas (tachadas).
  const tasksOn = (day: ISODate): Task[] => [
    ...tasksDueOn(tasks, day),
    ...(showDone ? sortTasks(tasks.filter((t) => t.status === 'done' && !t.deleted_at && t.due_date === day)) : []),
  ];
  const tasksByDay = new Map(days.map((d) => [d, tasksOn(d)]));

  const step = (dir: 1 | -1) => setCursor(mode === 'month' ? addMonths(cursor, dir) : addDays(cursor, mode === 'day' ? dir : dir * 7));
  const connected = hasCalendar(outlook.status);
  const extra = hasExtra(outlook) ? outlook.extra : null;
  // Las reuniones llegan justo al tope del flujo de Power Automate (256): faltan las últimas. Se avisa al entrar.
  const capped = !!outlook.events && looksCapped(outlook.events.length);

  return (
    <div className="relative flex h-full overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {capped && capNotice && (
        <CapNotice onClose={() => setCapNotice(false)}>
          <div className="space-y-3 text-sm">
            <p>
              Tienes <b>{outlook.events!.length} reuniones</b> subidas, justo el máximo que deja pasar tu flujo de Power Automate
              ({OUTLOOK_CAP}). Las últimas semanas pueden no salir en Marea.
            </p>
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Habla con un administrador para cambiar tu flujo a 1000 reuniones.
            </p>
            <p className="text-xs text-zinc-500">
              El cambio está en el paso «Obtener vista de calendario de eventos (V3)» → Parámetros avanzados → «Recuento superior» («Recompte superior» en catalán): 1000.
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={() => setCapNotice(false)} autoFocus
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Entendido</button>
            </div>
          </div>
        </CapNotice>
      )}
      {sidebar && (
        <aside className="hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-zinc-50/70 p-3 lg:flex dark:border-zinc-800 dark:bg-zinc-900/40">
          <h1 className="flex items-center gap-2 px-1 text-lg font-semibold">Calendario<ImprovingBadge /></h1>
          <MiniMonth selected={mode === 'month' ? [] : days} cursor={cursor} onPick={setCursor} />
          <section>
            <h2 className="mb-1 px-1 text-sm font-semibold">Mis calendarios</h2>
            {connected ? (
              <Toggle checked={showMeetings} onChange={setShowMeetings} color="#2E6BE6" label="Reuniones (Outlook)" />
            ) : (
              <a href={routeHref({ view: 'settings' })} className="flex items-center gap-2 rounded px-1 py-1 text-sm text-violet-600 hover:bg-zinc-100 dark:text-violet-400 dark:hover:bg-zinc-800">
                <Plus className="size-4" />Conectar Outlook
              </a>
            )}
            {extra && <Toggle checked={showExtra} onChange={setShowExtra} color={EXTRA_COLOR} label={extra.name ?? 'Otro calendario'} />}
            <Toggle checked={showTasks} onChange={setShowTasks} color="#244B98" label="Tareas" />
            {showTasks && <Toggle checked={showDone} onChange={setShowDone} color="#a1a1aa" label="Completadas" indent />}
          </section>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior, como Teams */}
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2">
          <IconButton label={sidebar ? 'Ocultar el panel' : 'Mostrar el panel'} onClick={() => setSidebar(!sidebar)}><PanelLeft className="size-4" /></IconButton>
          <button type="button" onClick={() => setCursor(today)} className="ml-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <CalendarDays className="size-4" />Hoy
          </button>
          {mode !== 'list' && (
            <>
              <IconButton label="Anterior" onClick={() => step(-1)}><ChevronLeft className="size-4" /></IconButton>
              <IconButton label="Siguiente" onClick={() => step(1)}><ChevronRight className="size-4" /></IconButton>
              <Popover width="w-64" trigger={(toggle) => (
                <button type="button" onClick={toggle} className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-base font-semibold hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  {rangeLabel(mode, cursor, days)}<ChevronDown className="size-4 text-zinc-500" />
                </button>
              )}>
                {(close) => <div className="p-2"><MiniMonth selected={mode === 'month' ? [] : days} cursor={cursor} onPick={(d) => { setCursor(d); close(); }} /></div>}
              </Popover>
            </>
          )}

          <span className="ml-auto flex items-center gap-1">
            {((connected && showMeetings) || (extra && showExtra)) && (
              <IconButton label={outlook.error ?? 'Actualizar reuniones'} onClick={() => void loadOutlook(true)}>
                <RefreshCw className={`size-4 ${outlook.loading ? 'animate-spin' : ''} ${outlook.error ? 'text-amber-600' : ''}`} />
              </IconButton>
            )}
            <Popover align="right" width="w-52" trigger={(toggle) => (
              <button type="button" onClick={toggle} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <CalendarDays className="size-4" />{MODES.find((m) => m.id === mode)?.label}<ChevronDown className="size-3.5 text-zinc-500" />
              </button>
            )}>
              {(close) => MODES.map((m) => (
                <MenuItem key={m.id} onClick={() => { setMode(m.id); close(); }}>
                  <span className="flex-1">{m.label}</span>{mode === m.id && <Check className="size-4 text-indigo-600" />}
                </MenuItem>
              ))}
            </Popover>
            <button type="button" onClick={() => { track('calendar-new'); open({ kind: 'capture', defaults: mode === 'list' ? {} : { due_date: cursor } }); }}
              className="ml-1 flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
              <Plus className="size-4" />Nuevo
            </button>
          </span>
        </div>

        <div className="min-h-0 flex-1">
          {mode === 'month' && (
            <MonthGrid
              cursor={cursor}
              tasksOn={showTasks ? tasksOn : () => []}
              releasesOn={() => []}
              meetings={meetings}
            />
          )}
          {mode === 'list' && <div className="h-full overflow-y-auto border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"><WeekView /></div>}
          {mode !== 'month' && mode !== 'list' && (
            <WeekAgenda days={days} tasksByDay={tasksByDay} meetings={meetings} showTasks={showTasks} />
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
      {children}
    </button>
  );
}

function Toggle({ checked, onChange, color, label, indent }: { checked: boolean; onChange: (v: boolean) => void; color: string; label: string; indent?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${indent ? 'pl-6 text-zinc-500' : ''}`}>
      <span className="flex size-4 shrink-0 items-center justify-center rounded border-2" style={{ borderColor: color, background: checked ? color : 'transparent' }}>
        {checked && <Check className="size-3 text-white" strokeWidth={3} />}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      {label}
    </label>
  );
}

/** Minicalendario del mes (como el de Teams): pulsar un día lleva a él; se resaltan los días que se ven. */
function MiniMonth({ selected, cursor, onPick }: { selected: ISODate[]; cursor: ISODate; onPick: (day: ISODate) => void }) {
  const { today } = useApp();
  const [month, setMonth] = useState(cursor);
  useEffect(() => setMonth(cursor), [cursor]);
  const grid = monthGrid(month);
  const current = parseISODate(month).getMonth();
  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center px-1">
        <span className="flex-1 font-medium">{capital(monthName(month, { month: 'long', year: 'numeric' }))}</span>
        <button type="button" onClick={() => setMonth(addMonths(month, -1))} className="rounded p-1 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800" aria-label="Mes anterior"><ChevronUp className="size-4" /></button>
        <button type="button" onClick={() => setMonth(addMonths(month, 1))} className="rounded p-1 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800" aria-label="Mes siguiente"><ChevronDown className="size-4" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-zinc-500">
        {LETTERS.map((l) => <span key={l} className="py-1">{l}</span>)}
      </div>
      {grid.map((week) => {
        const inRange = week.filter((d) => selected.includes(d));
        return (
          <div key={week[0]} className="grid grid-cols-7 text-center text-xs">
            {week.map((d) => {
              const on = inRange.includes(d);
              const first = on && d === inRange[0];
              const last = on && d === inRange[inRange.length - 1];
              return (
                <button key={d} type="button" onClick={() => onPick(d)}
                  className={`flex h-7 items-center justify-center ${on ? `bg-indigo-100 dark:bg-indigo-950 ${first ? 'rounded-l-md' : ''} ${last ? 'rounded-r-md' : ''}` : 'rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800'}
                    ${parseISODate(d).getMonth() === current ? '' : 'text-zinc-400'}`}>
                  <span className={`flex size-6 items-center justify-center rounded-full ${d === today ? 'bg-indigo-600 font-semibold text-white' : ''}`}>{parseISODate(d).getDate()}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Mes en cuadrícula de lunes a domingo, que ocupa el alto disponible. */
function MonthGrid({ cursor, tasksOn, releasesOn, meetings }: {
  cursor: ISODate;
  tasksOn: (day: ISODate) => Task[];
  releasesOn: (day: ISODate) => { id: string; name: string; status: string }[];
  meetings: Map<ISODate, CalendarEvent[]>;
}) {
  const grid = monthGrid(cursor);
  const current = parseISODate(cursor).getMonth();
  return (
    <div className="flex h-full flex-col border-t border-zinc-200 dark:border-zinc-800">
      <div className="grid shrink-0 grid-cols-7 border-b border-zinc-200 bg-zinc-50 text-center text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
        {WEEKDAYS.map((d) => <div key={d} className="py-1.5">{d}</div>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid min-h-full" style={{ gridTemplateRows: `repeat(${grid.length}, minmax(7rem, 1fr))` }}>
          {grid.map((week) => (
            <div key={week[0]} className="grid grid-cols-7 border-b border-zinc-200 last:border-0 dark:border-zinc-800">
              {week.map((day) => (
                <DayCell
                  key={day}
                  day={day}
                  inMonth={parseISODate(day).getMonth() === current}
                  tasks={tasksOn(day)}
                  releases={releasesOn(day)}
                  meetings={meetings.get(day) ?? []}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayCell({ day, inMonth, tasks, releases, meetings }: {
  day: ISODate;
  inMonth: boolean;
  tasks: Task[];
  releases: { id: string; name: string; status: string }[];
  meetings: CalendarEvent[];
}) {
  const { today, settings, itemTypes, projectMap, editTask, detailId } = useApp();
  const { moveIds } = useTaskActions();
  const { over, dropProps } = useTaskDrop((ids) => void moveIds(ids, { due_date: day }, 'Fecha cambiada'));
  const isToday = day === today;
  const [expanded, setExpanded] = useState(false);
  // Reuniones primero; entre las dos, como mucho MAX_VISIBLE hasta pulsar "+N más".
  const visibleMeetings = expanded ? meetings : meetings.slice(0, MAX_VISIBLE);
  const visible = expanded ? tasks : tasks.slice(0, Math.max(0, MAX_VISIBLE - visibleMeetings.length));
  const extra = tasks.length + meetings.length - visible.length - visibleMeetings.length;

  return (
    <div
      {...dropProps}
      className={`min-w-0 border-r border-zinc-200 p-1 last:border-r-0 dark:border-zinc-800
        ${inMonth ? '' : 'bg-zinc-50/70 text-zinc-400 dark:bg-zinc-900/40'}
        ${!isWorkday(day, settings.workdays) && inMonth ? 'bg-zinc-50/40 dark:bg-zinc-900/20' : ''}
        ${over ? dropHighlight : ''}`}
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <span className={`flex size-6 items-center justify-center rounded-full text-xs ${isToday ? 'bg-indigo-600 font-semibold text-white' : ''}`}>
          {parseISODate(day).getDate()}
        </span>
      </div>
      <ul className="space-y-0.5">
        {releases.map((r) => (
          <li key={r.id} className={`flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] font-semibold ${r.status === 'released' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300'}`}>
            <Rocket className="size-3 shrink-0" />{r.name}
          </li>
        ))}
        {visibleMeetings.map((m) => <li key={`${m.uid}|${m.time}`}><MeetingItem event={m} compact /></li>)}
        {visible.map((t) => {
          const project = t.project_id ? projectMap.get(t.project_id) : undefined;
          const late = t.status === 'todo' && day < today;
          return (
            <li key={t.id}>
              <button
                type="button"
                draggable
                data-opens-task
                onDragStart={(e) => setDraggedTasks(e, [t.id])}
                onClick={() => editTask(t)}
                title={t.title}
                className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800
                  ${t.status === 'done' ? 'text-zinc-400 line-through' : late ? 'text-amber-700 dark:text-amber-400' : ''}
                  ${detailId === t.id ? 'ring-1 ring-indigo-400' : ''}`}
              >
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: project?.color ?? '#a1a1aa' }} />
                <TypeBadge type={findType(itemTypes, t.type_id)} />
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          );
        })}
        {extra > 0 && (
          <li>
            <button type="button" onClick={() => setExpanded(true)} className="px-1 text-[11px] text-zinc-500 hover:underline">+{extra} más</button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Ventana centrada en el propio calendario (no en toda la pantalla), con fondo oscurecido solo sobre él. Esc o clic fuera la cierran. */
function CapNotice({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4 dark:bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="cap-notice-title"
        className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2 id="cap-notice-title" className="mb-3 font-semibold">Faltan reuniones en tu calendario</h2>
        {children}
      </div>
    </div>
  );
}
