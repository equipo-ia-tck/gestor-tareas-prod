import { useApp } from '../../app/AppContext';
import { QuickAdd } from '../../components/QuickAdd';
import { Section, TaskList } from '../../components/TaskList';
import { formatMinutes, isWorkday, parseISODate, weekdayName } from '../../domain/dates';
import { completedOn, myDayTasks, tasksDueOn, totalMinutes } from '../../domain/selectors';
import { ClipboardCheck, Sun } from 'lucide-react';
import { reviewDue } from '../../domain/maintenance';
import { routeHref } from '../../app/router';
import { repo } from '../../data/services';
import { useTaskActions } from '../../hooks/useTaskActions';
import { OverdueBlock } from '../maintenance/OverdueBlock';
import { StaleBlock } from '../maintenance/StaleBlock';
import { LoadBar } from './LoadBar';
import { ViewHeader } from './ViewHeader';
import { DailySummary } from '../summary/DailySummary';

export function TodayView() {
  const { tasks, today, projectMap, settings, editTask } = useApp();
  const { moveIds } = useTaskActions();
  const myDay = myDayTasks(tasks, today);
  // Lo que ya está en Mi día no se repite en "Para hoy".
  const dueToday = tasksDueOn(tasks, today).filter((t) => t.my_day !== today);
  const done = completedOn(tasks, today);
  const load = totalMinutes(dueToday);
  const capacity = isWorkday(today, settings.workdays) ? settings.capacity_minutes : 0;
  const d = parseISODate(today);
  const list = { today, projects: projectMap, onEdit: editTask };

  return (
    <>
      <ViewHeader
        title="Hoy"
        subtitle={`${weekdayName(today, true)} ${d.getDate()} de ${d.toLocaleDateString('es-ES', { month: 'long' })}`}
      />
      {reviewDue(settings.ui.last_review_on, today) && (
        <a href={routeHref({ view: 'review' })} className="mb-4 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-900/60">
          <ClipboardCheck className="size-4" /><span className="flex-1">Toca la <strong>revisión semanal</strong>: 10 minutos para dejarlo todo en orden.</span><span className="text-xs">Empezar →</span>
        </a>
      )}
      <DailySummary />
      <QuickAdd defaults={{ due_date: today }} placeholder="Añadir para hoy… (#proyecto @persona !1)" />

      <Section
        title={<span className="inline-flex items-center gap-1.5"><Sun className="size-3.5 text-amber-500" />Mi día · {myDay.length}</span>}
        aside={myDay.length > 0 && <LoadBar load={totalMinutes(myDay)} capacity={capacity} />}
        onDropTasks={(ids) => void repo.batch(ids.length === 1 ? 'Añadida a Mi día' : `${ids.length} añadidas a Mi día`, async () => {
          for (const taskId of ids) await repo.updateTask(taskId, { my_day: today });
        })}
      >
        <TaskList {...list} tasks={myDay} empty="Elige lo que harás hoy: ☀ en una tarea, la tecla A o arrástrala aquí. No cambia su fecha." />
      </Section>

      <OverdueBlock />

      <Section
        title={`Para hoy · ${dueToday.length}`}
        aside={<LoadBar load={load} capacity={capacity} />}
        onDropTasks={(ids) => void moveIds(ids, { due_date: today }, 'Movida a hoy')}
      >
        <TaskList {...list} tasks={dueToday} hideDate empty="Nada previsto para hoy." />
        {capacity > 0 && load > capacity && (
          <p className="px-2 pt-1 text-xs text-amber-600 dark:text-amber-400">
            Hoy tienes {formatMinutes(load)} estimados y tu capacidad es de {formatMinutes(capacity)}.
          </p>
        )}
      </Section>

      {done.length > 0 && (
        <Section title={`Completadas hoy · ${done.length}`} collapsible defaultOpen={false}>
          <TaskList {...list} tasks={done} hideDate />
        </Section>
      )}

      <StaleBlock />
    </>
  );
}
