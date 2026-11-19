import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { useApp } from '../../app/AppContext';
import { Popover } from '../../components/ui/Popover';
import { TypeBadge } from '../../components/ui/Badges';
import { DEFAULT_MEETING_MINUTES, hourRange, layoutDay, minutesOf } from '../../domain/agenda';
import { parseISODate, weekdayName } from '../../domain/dates';
import type { CalendarEvent } from '../../domain/ics';
import type { ISODate, Task } from '../../domain/types';
import { findType } from '../../domain/workflows';
import { useTaskActions } from '../../hooks/useTaskActions';
import { dropHighlight, setDraggedTasks, useTaskDrop } from '../../hooks/useTaskDrop';
import { MeetingDetails, timeRange } from './Meetings';
import { NewMeeting } from './NewMeeting';
import { EXTRA_COLOR, isPendingMeeting } from './outlook';

/** Alto de una hora en la agenda (px): como Teams, una reunión de 30 minutos cabe en una línea holgada. */
const HOUR = 80;
const MAX_TASKS = 3;

const eventRange = (e: CalendarEvent) => {
  const start = minutesOf(e.time!);
  return { start, end: e.end ? minutesOf(e.end) : start + DEFAULT_MEETING_MINUTES };
};

/** Barra de color de la izquierda: lisa si está ocupado, rayada si es provisional (como Outlook). */
function barStyle(e: CalendarEvent): CSSProperties {
  // Outlook en el azul de Marea; el otro calendario (La Caixa…), en verde.
  const color = e.calendar ? EXTRA_COLOR : '#2E6BE6';
  if (e.showAs === 'tentative') return { backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)` };
  if (e.showAs === 'free') return { background: 'transparent', boxShadow: `inset 0 0 0 1px ${color}` };
  if (e.showAs === 'oof') return { background: '#c026d3' };
  return { background: color };
}

/** Fondo de la tarjeta: violeta para Outlook, verde para el otro calendario. */
const cardBg = (e: CalendarEvent) => (e.calendar ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-violet-100 dark:bg-violet-950');

/**
 * Agenda por horas como en Teams (Día, Semana laboral o Semana): una columna por día y las reuniones colocadas a su
 * hora (las que se solapan, una al lado de otra). Arriba de cada día, sus tareas y las reuniones de todo el día; se puede
 * soltar una tarea para cambiarle la fecha. Ocupa el alto disponible: la cabecera queda fija y solo las horas hacen scroll.
 */
export function WeekAgenda({ days, tasksByDay, meetings, showTasks }: {
  days: ISODate[];
  tasksByDay: Map<ISODate, Task[]>;
  meetings: Map<ISODate, CalendarEvent[]>;
  showTasks: boolean;
}) {
  const { today } = useApp();
  const timed = new Map(days.map((d) => [d, layoutDay((meetings.get(d) ?? []).filter((e) => e.time), eventRange)]));
  // De 9 a 19 (la última franja, 19:00–20:00, también se ve), ampliado si hay reuniones fuera.
  const [from, to] = hourRange([...timed.values()].flat(), 9, 20);
  const cols = { gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` };

  // Línea de la hora actual (se mueve cada minuto).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Doble clic en una hora vacía: reunión nueva de Teams en esa media hora.
  const [draft, setDraft] = useState<{ date: ISODate; time: string } | null>(null);
  const onDoubleClick = (day: ISODate) => (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, [data-popover]')) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const minutes = Math.min(23 * 60 + 30, Math.max(0, Math.floor((from * 60 + (y / HOUR) * 60) / 30) * 30));
    setDraft({ date: day, time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` });
  };

  // La cabecera reserva el mismo hueco que la barra de scroll de las horas, para que las columnas cuadren.
  const gutter: CSSProperties = { scrollbarGutter: 'stable' };

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-zinc-200 dark:border-zinc-800">
      <div className="shrink-0 overflow-hidden" style={gutter}>
        {/* Cabecera: número y día */}
        <div className="grid border-b border-zinc-200 dark:border-zinc-800" style={cols}>
          <div />
          {days.map((d) => (
            <div key={d} className={`border-l border-zinc-200 px-2 pt-1.5 pb-1 dark:border-zinc-800 ${d === today ? 'border-t-2 border-t-indigo-600' : ''}`}>
              <div className={`text-2xl leading-none ${d === today ? 'font-semibold text-indigo-600 dark:text-indigo-400' : d < today ? 'text-zinc-400' : 'text-zinc-700 dark:text-zinc-200'}`}>{parseISODate(d).getDate()}</div>
              <div className={`text-xs capitalize ${d === today ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500'}`}>{weekdayName(d, true)}</div>
            </div>
          ))}
        </div>

        {/* Tareas del día y reuniones de todo el día */}
        {(showTasks || days.some((d) => meetings.get(d)?.some((e) => !e.time))) && (
          <div className="grid max-h-40 overflow-y-auto border-b border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40" style={cols}>
            <div className="px-1 pt-1.5 text-right text-[10px] text-zinc-400">{showTasks ? 'Tareas' : ''}</div>
            {days.map((d) => (
              <DayTasks key={d} day={d} tasks={showTasks ? tasksByDay.get(d) ?? [] : []} allDay={(meetings.get(d) ?? []).filter((e) => !e.time)} />
            ))}
          </div>
        )}
      </div>

      {/* Horas: lo único que hace scroll */}
      <div className="min-h-0 flex-1 overflow-y-auto" style={gutter}>
        <div className="grid" style={cols}>
          <div className="relative" style={{ height: (to - from) * HOUR }}>
            {/* Como en Teams: la hora arriba de su franja, con su línea y la de la media hora. */}
            {Array.from({ length: to - from }, (_, i) => (
              <div key={i} className="absolute inset-x-0 border-t border-zinc-200 dark:border-zinc-800" style={{ top: i * HOUR, height: HOUR }}>
                <span className="absolute top-1 right-2 text-xs text-zinc-500">{from + i}</span>
                <div className="absolute right-0 left-1/2 border-t border-zinc-100 dark:border-zinc-800/60" style={{ top: HOUR / 2 }} />
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d} onDoubleClick={onDoubleClick(d)} title="Doble clic para crear una reunión de Teams"
              className={`relative border-l border-zinc-200 dark:border-zinc-800 ${d === today ? 'bg-indigo-50/30 dark:bg-indigo-950/10' : ''}`} style={{ height: (to - from) * HOUR }}>
              {Array.from({ length: to - from }, (_, i) => (
                <div key={i} className="absolute inset-x-0 border-t border-zinc-200 dark:border-zinc-800" style={{ top: i * HOUR }}>
                  <div className="border-t border-zinc-100 dark:border-zinc-800/60" style={{ marginTop: HOUR / 2 - 1 }} />
                </div>
              ))}
              {d === today && nowMinutes >= from * 60 && nowMinutes <= to * 60 && (
                <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: ((nowMinutes - from * 60) / 60) * HOUR }}>
                  <span className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-red-500" />
                </div>
              )}
              {timed.get(d)!.map((b) => {
                const top = ((b.start - from * 60) / 60) * HOUR;
                const height = Math.max(22, ((b.end - b.start) / 60) * HOUR - 3);
                // Corta (≤ 30 min): título y organizador en una línea. Más larga: título en dos líneas y debajo el resto.
                const tall = height >= 56;
                const e = b.item;
                const pending = isPendingMeeting(e);
                return (
                  <Popover
                    key={`${e.uid}|${e.time}`}
                    width="w-80"
                    className="absolute px-0.5"
                    style={{ top: top + 1, height, left: `${(b.col / b.cols) * 100}%`, width: `${100 / b.cols}%` }}
                    trigger={(toggle, open) => (
                      <button
                        type="button"
                        onClick={toggle}
                        title={`${timeRange(e)} · ${e.title}${e.organizer ? ` · ${e.organizer.name}` : ''}${e.calendar ? ` · ${e.calendar}` : ''}`}
                        className={`flex h-full w-full overflow-hidden rounded-md text-left text-xs shadow-sm ring-violet-400 hover:brightness-95
                          ${pending ? 'border border-dashed border-violet-400 bg-white/80 dark:bg-zinc-900/80' : e.showAs === 'free' ? 'bg-white dark:bg-zinc-900' : cardBg(e)}
                          ${open ? 'ring-2' : ''} ${d < today ? 'opacity-70' : ''}`}
                      >
                        <span className="w-1 shrink-0" style={barStyle(e)} />
                        {tall ? (
                          <span className="min-w-0 flex-1 px-2 py-1 leading-snug">
                            <span className="line-clamp-2 font-semibold">{e.title}</span>
                            {e.organizer && <span className="block truncate text-zinc-500 dark:text-zinc-400">{e.organizer.name}</span>}
                            {height >= 76 && <span className="block text-[11px] text-violet-700 dark:text-violet-300">{timeRange(e)}</span>}
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 truncate px-2 py-1 leading-snug whitespace-nowrap">
                            <span className="font-semibold">{e.title}</span>
                            {e.organizer && <span className="text-zinc-500 dark:text-zinc-400"> {e.organizer.name}</span>}
                          </span>
                        )}
                      </button>
                    )}
                  >
                    {(close) => <MeetingDetails event={e} close={close} />}
                  </Popover>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {draft && <NewMeeting source="dblclick" date={draft.date} time={draft.time} onClose={() => setDraft(null)} />}
    </div>
  );
}

function DayTasks({ day, tasks, allDay }: { day: ISODate; tasks: Task[]; allDay: CalendarEvent[] }) {
  const { today, itemTypes, projectMap, editTask, detailId } = useApp();
  const { moveIds } = useTaskActions();
  const { over, dropProps } = useTaskDrop((ids) => void moveIds(ids, { due_date: day }, 'Fecha cambiada'));
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? tasks : tasks.slice(0, MAX_TASKS);

  return (
    <div {...dropProps} className={`min-h-9 space-y-0.5 border-l border-zinc-200 p-1 dark:border-zinc-800 ${over ? dropHighlight : ''}`}>
      {allDay.map((e) => (
        <Popover key={e.uid} width="w-80" className="block" trigger={(toggle) => (
          <button type="button" onClick={toggle} className={`flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium ${cardBg(e)}`}>
            <span className="h-3 w-0.5 shrink-0" style={barStyle(e)} />
            <span className="truncate">{e.title}</span>
          </button>
        )}>
          {(close) => <MeetingDetails event={e} close={close} />}
        </Popover>
      ))}
      {visible.map((t) => {
        const project = t.project_id ? projectMap.get(t.project_id) : undefined;
        const late = t.status === 'todo' && day < today;
        return (
          <button
            key={t.id}
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
        );
      })}
      {tasks.length > visible.length && (
        <button type="button" onClick={() => setExpanded(true)} className="px-1 text-[11px] text-zinc-500 hover:underline">+{tasks.length - visible.length} más</button>
      )}
    </div>
  );
}
