import { useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, ClipboardCheck } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { navigate, routeHref } from '../../app/router';
import { Section, SmallButton, TaskList } from '../../components/TaskList';
import { Avatar } from '../../components/ui/Badges';
import { repo } from '../../data/services';
import { dailyLog } from '../../domain/activity';
import { addDays, formatDay, formatMinutes, mondayOf, weekdayName } from '../../domain/dates';
import { nextMonday, staleTasks } from '../../domain/maintenance';
import { inboxTasks, isActive, overdueTasks, sortTasks, weekPlan } from '../../domain/selectors';
import { nameKey } from '../../domain/text';
import { TOPIC_TYPE_ID, type Task } from '../../domain/types';
import { useTaskActions } from '../../hooks/useTaskActions';
import { useCommandCenter } from '../command/CommandCenter';
import { StaleBlock } from '../maintenance/StaleBlock';
import { LoadBar } from '../views/LoadBar';
import { ViewHeader } from '../views/ViewHeader';

const STEPS = ['Bandeja', 'Atrasadas', 'Cómo fue la semana', 'Para hablar', 'La semana que viene', 'Sin tocar'] as const;

/** Revisión semanal guiada (unos 10 minutos): dejar todo en orden y la semana siguiente planificada. */
export function ReviewView() {
  const { settings, today, tasks } = useApp();
  const [step, setStep] = useState(0);
  // Cuántas tareas hay que mirar en cada paso (los de resumen no llevan número).
  const counts: (number | null)[] = [
    inboxTasks(tasks).length,
    overdueTasks(tasks, today).length,
    null,
    tasks.filter((t) => t.type_id === TOPIC_TYPE_ID && isActive(t)).length,
    null,
    staleTasks(tasks, today).length,
  ];
  const last = step === STEPS.length - 1;

  async function finish() {
    await repo.updateSettings({ ui: { ...settings.ui, last_review_on: today } });
    navigate({ view: 'today' });
  }

  return (
    <>
      <ViewHeader
        title={<span className="flex items-center gap-2"><ClipboardCheck className="size-5 text-indigo-500" />Revisión semanal</span>}
        subtitle={settings.ui.last_review_on ? `Última: ${formatDay(settings.ui.last_review_on, today).toLowerCase()}` : 'Diez minutos para dejarlo todo en orden'}
      />
      <ol className="mb-6 flex flex-wrap gap-1">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${i === step ? 'bg-indigo-600 font-medium text-white' : i < step ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'}`}>
              {i < step && <Check className="size-3" />}{s}
              {counts[i] !== null && (
                <span title={`${counts[i]} ${counts[i] === 1 ? 'tarea' : 'tareas'}`}
                  className={`min-w-4 rounded-full px-1 text-center text-[10px] font-semibold ${i === step ? 'bg-white/25' : counts[i] ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' : 'opacity-60'}`}>
                  {counts[i]}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && <InboxStep />}
      {step === 1 && <OverdueStep />}
      {step === 2 && <PastWeekStep />}
      {step === 3 && <TopicsStep />}
      {step === 4 && <NextWeekStep />}
      {step === 5 && <StaleStep />}

      <div className="mt-8 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}
          className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
          <ChevronLeft className="size-4" />Anterior
        </button>
        {last ? (
          <button type="button" onClick={() => void finish()} className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">
            <Check className="size-4" />Revisión hecha
          </button>
        ) : (
          <button type="button" onClick={() => setStep(step + 1)} className="flex items-center gap-1 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            Siguiente<ChevronRight className="size-4" />
          </button>
        )}
      </div>
    </>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}

function Done({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">✓ {children}</p>;
}

function InboxStep() {
  const { tasks, today, projectMap, editTask } = useApp();
  const { reschedule, remove } = useTaskActions();
  const inbox = inboxTasks(tasks);
  return (
    <>
      <Hint>Decide qué hacer con cada cosa: ponle fecha, ábrela para darle proyecto (clic), o elimínala si ya no importa.</Hint>
      {!inbox.length ? <Done>Bandeja vacía.</Done> : (
        <TaskList tasks={inbox} today={today} projects={projectMap} onEdit={editTask}
          extra={(t) => (
            <>
              <SmallButton onClick={() => void reschedule([t], today)}>Hoy</SmallButton>
              <SmallButton onClick={() => void reschedule([t], nextMonday(today))}>Lunes</SmallButton>
              <SmallButton onClick={() => void remove([t])}>Eliminar</SmallButton>
            </>
          )} />
      )}
    </>
  );
}

function OverdueStep() {
  const { tasks, today, projectMap, editTask } = useApp();
  const { reschedule, remove } = useTaskActions();
  const { open } = useCommandCenter();
  const overdue = overdueTasks(tasks, today);
  return (
    <>
      <Hint>Lo que se quedó atrás: muévelo a cuando de verdad lo vas a hacer, quítale la fecha o elimínalo. «Repartir» lo coloca solo según tu capacidad.</Hint>
      {!overdue.length ? <Done>Nada atrasado.</Done> : (
        <>
          <div className="mb-2 flex gap-2">
            <SmallButton onClick={() => open({ kind: 'distribute' })}>Repartir todas…</SmallButton>
            <SmallButton onClick={() => void reschedule(overdue, nextMonday(today))}>Todas al lunes</SmallButton>
          </div>
          <TaskList tasks={overdue} today={today} projects={projectMap} onEdit={editTask}
            extra={(t) => (
              <>
                <SmallButton onClick={() => void reschedule([t], nextMonday(today))}>Lunes</SmallButton>
                <SmallButton onClick={() => void reschedule([t], null)}>Sin fecha</SmallButton>
                <SmallButton onClick={() => void remove([t])}>Eliminar</SmallButton>
              </>
            )} />
        </>
      )}
    </>
  );
}

function PastWeekStep() {
  const { activity, notes, tasks, today, postponed, editTask } = useApp();
  const days = dailyLog(activity, notes, mondayOf(today), today);
  const done = days.flatMap((d) => d.completed);
  const dropped = days.flatMap((d) => d.dropped);
  // Lo que más se arrastra: pendientes pospuestas 2 veces o más.
  const dragging = sortTasks(tasks.filter((t) => isActive(t) && (postponed.get(t.id) ?? 0) >= 2));
  return (
    <>
      <Hint>Un vistazo a lo que ha pasado esta semana. Lo que llevas posponiendo una y otra vez merece una decisión: ¿hacerlo, delegarlo o dejarlo?</Hint>
      <div className="mb-5 grid grid-cols-3 gap-2">
        <Tile label="Hechas" value={done.length} />
        <Tile label="Dejadas" value={dropped.length} />
        <Tile label="Notas y actas" value={days.reduce((s, d) => s + d.notes.length, 0)} />
      </div>
      {done.length > 0 && (
        <Section title={`Hecho esta semana · ${done.length}`} collapsible defaultOpen={false}>
          <ul className="space-y-0.5 px-2 text-sm">{done.map((e) => <li key={e.id}>✓ {e.title}</li>)}</ul>
        </Section>
      )}
      <Section title={`Pospuestas varias veces · ${dragging.length}`}>
        {!dragging.length ? <Done>Nada que se esté arrastrando.</Done> : (
          <ul className="px-2 text-sm">
            {dragging.map((t) => (
              <li key={t.id} className="flex justify-between py-0.5">
                <button type="button" onClick={() => editTask(t)} className="hover:underline">{t.title}</button>
                <span className="text-xs text-amber-600">{postponed.get(t.id)}×</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function TopicsStep() {
  const { tasks } = useApp();
  const { toggleDone } = useTaskActions();
  const topics = tasks.filter((t) => t.type_id === TOPIC_TYPE_ID && isActive(t));
  const byPerson = new Map<string, { name: string; items: Task[] }>();
  for (const t of topics) {
    for (const p of t.people.length ? t.people : ['Sin persona']) {
      const g = byPerson.get(nameKey(p)) ?? { name: p, items: [] };
      g.items.push(t);
      byPerson.set(nameKey(p), g);
    }
  }
  return (
    <>
      <Hint>Lo que tienes pendiente de hablar con cada persona. Márcalo si ya está hablado; si no, ya sabes qué sacar en la próxima reunión.</Hint>
      {!topics.length ? <Done>Nada pendiente de hablar.</Done> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {[...byPerson.values()].map((g) => (
            <div key={g.name} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <a href={routeHref({ view: 'person', name: g.name })} className="mb-1.5 flex items-center gap-2 text-sm font-medium hover:underline">
                <Avatar name={g.name} size={20} />{g.name}
              </a>
              <ul className="space-y-1 text-sm">
                {g.items.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <button type="button" title="Hablado" onClick={() => void toggleDone([t])}
                      className="mt-0.5 size-3.5 shrink-0 rounded-full border border-amber-500 hover:bg-amber-100 dark:hover:bg-amber-950" />
                    {t.title}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function NextWeekStep() {
  const { tasks, settings, today, projectMap, editTask } = useApp();
  const start = mondayOf(addDays(today, 7));
  const plan = weekPlan(tasks, start, settings);
  const total = plan.reduce((s, d) => s + d.load, 0);
  const cap = plan.reduce((s, d) => s + d.capacity, 0);
  return (
    <>
      <Hint>
        La semana que viene: {formatMinutes(total)} estimados de {formatMinutes(cap)}. Si un día está sobrecargado, abre la tarea y muévela (o arrástrala en el Calendario).
      </Hint>
      {plan.map((d) => (
        <Section key={d.date} title={`${weekdayName(d.date, true)} ${d.date.slice(8)} · ${d.tasks.length}`} aside={<LoadBar load={d.load} capacity={d.capacity} />}>
          <TaskList tasks={d.tasks} today={today} projects={projectMap} onEdit={editTask} hideDate empty="—" />
        </Section>
      ))}
    </>
  );
}

function StaleStep() {
  return (
    <>
      <Hint>Tareas que llevan más de 30 días sin tocarse. Archívalas si ya no importan o «Mantener» si siguen vivas.</Hint>
      <StaleBlock />
      <p className="mt-2 text-sm text-zinc-400">Si no aparece nada, no hay tareas olvidadas. 🎉</p>
    </>
  );
}
