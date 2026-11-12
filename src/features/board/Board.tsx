import { useMemo, useState, type KeyboardEvent } from 'react';
import { AlignLeft, Calendar, Plus, Repeat } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { Avatar, AvatarStack, ChecklistProgress, ExternalChip, LabelChip, PostponedChip, PriorityFlag, ReleaseChip, ReminderChip, TypeBadge } from '../../components/ui/Badges';
import { repo } from '../../data/services';
import { tint } from '../../domain/colors';
import { diffDays, formatDay } from '../../domain/dates';
import { sortTasks } from '../../domain/selectors';
import type { ItemType, NewTask, StateCategory, Task } from '../../domain/types';
import { findType, stateForCategory, stateOf } from '../../domain/workflows';
import { setDraggedTasks, useTaskDrop } from '../../hooks/useTaskDrop';
import { parseCapture } from '../../parser/parseCapture';
import { submitCapture } from '../capture/submitCapture';
import { useRallyItem, useRallyLookup } from '../rally/rallyStore';
import { moveToRallyColumn, moveToNeedReview } from '../rally/rallyStates';
import { useToast } from '../../components/Toast';
import { isRallyId, RALLY_COLUMNS, rallyColumnOf } from '../../domain/rally';

const NEED_REVIEW = 'Need Review';

/** Las completadas hace más de esto no se muestran en la columna "hecho" (para no saturarla). */
const DONE_VISIBLE_DAYS = 14;

interface Props {
  tasks: Task[];
  type: ItemType;
  /** Valores para las tarjetas nuevas (p. ej. el proyecto). */
  defaults?: Partial<NewTask>;
  showProject?: boolean;
}

interface ColumnDef {
  id: string;
  label: string;
  color: string;
  tasks: Task[];
  onDrop: (ids: string[]) => void;
  /** Valores de las tarjetas creadas en la columna. `category`: si el texto cambia el tipo (US-123), se ajusta el estado. */
  add: { label: string; defaults: Partial<NewTask>; category?: StateCategory };
}

/** Tareas visibles en un tablero: sin borradas ni archivadas, y las completadas solo si son recientes. */
function boardable(t: Task, today: string) {
  if (t.deleted_at || t.status === 'archived') return false;
  return !(t.status === 'done' && t.completed_at && diffDays(t.completed_at.slice(0, 10), today) > DONE_VISIBLE_DAYS);
}

const moveLabel = (n: number, to: string) => (n === 1 ? `Movida a ${to}` : `${n} tareas movidas a ${to}`);

/** Tablero de un tipo: una columna por cada estado de su flujo. */
export function Board({ tasks, type, defaults, showProject = true }: Props) {
  const { itemTypes, today } = useApp();
  const columns = useMemo<ColumnDef[]>(() => type.states.map((state) => ({
    id: state.id,
    label: state.name,
    color: state.color,
    tasks: sortTasks(tasks.filter((t) => boardable(t, today) && findType(itemTypes, t.type_id).id === type.id && stateOf(itemTypes, t).id === state.id)),
    onDrop: (ids) => void repo.batch(moveLabel(ids.length, state.name), async () => { for (const id of ids) await repo.setState(id, state.id); }),
    add: { label: state.name, defaults: { ...defaults, type_id: type.id, state_id: state.id } },
  })), [tasks, type, itemTypes, today, defaults]);
  return <BoardColumns columns={columns} showProject={showProject} />;
}

export const CATEGORY_COLUMNS: { category: StateCategory; label: string; color: string }[] = [
  { category: 'todo', label: 'Por hacer', color: '#94a3b8' },
  { category: 'blocked', label: 'Bloqueado', color: '#ef4444' },
  { category: 'doing', label: 'En curso', color: '#3b82f6' },
  { category: 'done', label: 'Hecho', color: '#22c55e' },
  { category: 'accepted', label: 'Accepted', color: '#047857' },
];

/**
 * Tablero mixto (tareas, US, TS, temas…): columnas por grupo de estado. Cada tarjeta muestra su estado
 * concreto; al soltarla pasa al primer estado de ese grupo dentro de su propio flujo.
 */
export function CategoryBoard({ tasks, defaults, showProject = true }: Omit<Props, 'type'>) {
  const { itemTypes, today } = useApp();
  const columns = useMemo<ColumnDef[]>(() => CATEGORY_COLUMNS.map(({ category, label, color }) => ({
    id: category,
    label,
    color,
    tasks: sortTasks(tasks.filter((t) => boardable(t, today) && stateOf(itemTypes, t).category === category)),
    onDrop: (ids) => void repo.batch(moveLabel(ids.length, label.toLowerCase()), async () => {
      for (const id of ids) {
        const t = tasks.find((x) => x.id === id);
        const state = t && findType(itemTypes, t.type_id).states.find((st) => st.category === category);
        if (state) await repo.setState(id, state.id);
      }
    }),
    add: { label, defaults: { ...defaults }, category },
  })), [tasks, itemTypes, today, defaults]);
  return <BoardColumns columns={columns} showProject={showProject} />;
}

/**
 * Tablero «Como en Rally»: las columnas del tablero de Rally en su orden (New, Defined, Blocked, In-Progress, Need Review,
 * Completed, Accepted; sin To Do ni Desarrollo, que van a la de su grupo). Las tarjetas enlazadas van a su columna de Rally; soltarlas
 * en otra las mueve allí en Rally (con su comentario) y en el gestor. Las que no están en Rally van por su grupo.
 */
export function RallyBoard({ tasks, defaults, showProject = true }: Omit<Props, 'type'>) {
  const { itemTypes, today } = useApp();
  const rallyOf = useRallyLookup();
  const toast = useToast();
  const columns = useMemo<ColumnDef[]>(() => {
    const visible = tasks.filter((t) => boardable(t, today));
    // La columna elegida al soltar (tareas que no están en Rally) vale mientras la tarea siga en el grupo de esa columna.
    const chosen = (t: Task) => {
      const col = RALLY_COLUMNS.find((c) => c.name === t.board_column);
      return col && stateForCategory(findType(itemTypes, t.type_id), col.category).id === stateOf(itemTypes, t).id ? col.name : null;
    };
    const columnOf = new Map(visible.map((t) => [t.id, rallyColumnOf(rallyOf(t.external_id)?.state, stateOf(itemTypes, t).category, chosen(t))]));
    return RALLY_COLUMNS.map(({ name, category, color }) => ({
      id: name,
      label: name,
      color,
      tasks: sortTasks(visible.filter((t) => columnOf.get(t.id) === name)),
      onDrop: (ids) => {
        let dropped = ids.map((id) => tasks.find((x) => x.id === id)).filter((t): t is Task => !!t && columnOf.get(t.id) !== name);
        const inRally = dropped.filter((t) => isRallyId(t.external_id) && rallyOf(t.external_id));
        // En Rally, Need Review es solo para TS (se abre defecto, se bloquea y se comenta, todo a la vez).
        if (name === NEED_REVIEW) {
          const isTs = (t: Task) => rallyOf(t.external_id)?.kind === 'TS';
          if (inRally.some((t) => !isTs(t))) toast('En Rally, solo los TS pueden ir a Need Review');
          for (const t of inRally.filter(isTs)) void moveToNeedReview(t, toast);
        } else {
          for (const t of inRally) void moveToRallyColumn(t, name, category, toast);
        }
        // Las que no están en Rally van a cualquier columna: pasan al estado de ese grupo y recuerdan la columna.
        const local = dropped.filter((t) => !inRally.includes(t));
        if (!local.length) return;
        void repo.batch(moveLabel(local.length, name), async () => {
          for (const t of local) {
            const state = stateForCategory(findType(itemTypes, t.type_id), category);
            if (state.id !== t.state_id) await repo.setState(t.id, state.id);
            await repo.updateTask(t.id, { board_column: name });
          }
        });
      },
      add: { label: name, defaults: { ...defaults, board_column: name }, category },
    }));
  }, [tasks, itemTypes, today, defaults, rallyOf, toast]);
  return <BoardColumns columns={columns} showProject={showProject} />;
}

function BoardColumns({ columns, showProject }: { columns: ColumnDef[]; showProject: boolean }) {
  return (
    <div className="-mx-6 flex gap-3 overflow-x-auto px-6 pb-4">
      {columns.map((c) => <Column key={c.id} column={c} showProject={showProject} />)}
    </div>
  );
}

function Column({ column: c, showProject }: { column: ColumnDef; showProject: boolean }) {
  const { over, dropProps } = useTaskDrop(c.onDrop);
  return (
    <section
      {...dropProps}
      aria-label={c.label}
      // Las columnas se reparten el ancho (también con el panel de la tarea abierto); por debajo de 11rem, scroll lateral.
      className={`flex min-w-44 flex-1 basis-0 flex-col rounded-xl p-2 transition-colors ${over ? 'ring-2 ring-indigo-400' : ''}`}
      style={{ background: tint(c.color, over ? 0.22 : 0.1) }}
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2.5 rounded-full" style={{ background: c.color }} />
        <h3 className="text-sm font-semibold">{c.label}</h3>
        <span className="text-xs text-zinc-500">{c.tasks.length}</span>
      </header>
      <ul className="flex min-h-8 flex-col gap-2">
        {c.tasks.map((t) => <Card key={t.id} task={t} showProject={showProject} />)}
      </ul>
      <AddCard add={c.add} />
    </section>
  );
}

function Card({ task, showProject }: { task: Task; showProject: boolean }) {
  const { itemTypes, projectMap, labelColors, today, editTask, detailId } = useApp();
  const type = findType(itemTypes, task.type_id);
  const project = task.project_id ? projectMap.get(task.project_id) : undefined;
  const done = task.status === 'done';
  const late = !done && task.due_date !== null && task.due_date < today;
  const dueToday = !done && task.due_date === today;
  const rally = useRallyItem(task.external_id);

  return (
    <li
      draggable
      onDragStart={(e) => setDraggedTasks(e, [task.id])}
      data-opens-task
      onClick={() => editTask(task)}
      className={`cursor-pointer rounded-lg border bg-white p-2.5 shadow-sm transition hover:shadow-md dark:bg-zinc-900
        ${detailId === task.id ? 'border-indigo-400 ring-1 ring-indigo-400' : 'border-zinc-200 dark:border-zinc-700'}`}
      style={project && showProject ? { borderLeft: `3px solid ${project.color}` } : undefined}
    >
      {task.tags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">{task.tags.map((t) => <LabelChip key={t} name={t} colors={labelColors} small />)}</div>
      )}
      <p className={`flex items-start gap-1.5 text-sm leading-snug ${done ? 'text-zinc-400 line-through' : ''}`}>
        <TypeBadge type={type} />
        <span className="flex-1">{task.title}</span>
        <PriorityFlag priority={task.priority} />
      </p>
      {showProject && project && <p className="mt-1 truncate text-[11px] text-zinc-500">{project.name}</p>}
      {(task.external_id || task.release_id) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><ExternalChip task={task} type={type} /><ReleaseChip releaseId={task.release_id} /></div>
      )}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        {task.due_date && (
          <span className={`inline-flex items-center gap-0.5 rounded px-1 ${late ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : dueToday ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : ''}`}>
            <Calendar className="size-3" />{formatDay(task.due_date, today)}
          </span>
        )}
        <ChecklistProgress items={task.checklist} />
        {!done && <ReminderChip at={task.remind_at} />}
        {!done && <PostponedChip taskId={task.id} />}
        {task.notes && <AlignLeft className="size-3" />}
        {task.recurrence_rule && <Repeat className="size-3" />}
        <span className="flex-1" />
        <AvatarStack names={task.people} size={20} />
      </div>
      {rally?.owner && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800" title="Owner en Rally">
          <Avatar name={rally.owner} size={22} />
          <span className="min-w-0 leading-tight">
            <span className="block text-[10px] text-zinc-400">Owned By:</span>
            <span className="block truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">{rally.owner}</span>
          </span>
        </div>
      )}
    </li>
  );
}

function AddCard({ add }: { add: ColumnDef['add'] }) {
  const { projects, today, itemTypes, releases, mentionables } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  async function submit() {
    const parsed = parseCapture(text, { today, projects, people: mentionables, types: itemTypes, releases }).filter((p) => p.title);
    if (!parsed.length) return;
    await repo.batch(parsed.length === 1 ? `Tarjeta creada en ${add.label}` : `${parsed.length} tarjetas creadas`, async () => {
      const created = await submitCapture(parsed, add.defaults);
      // En el tablero mixto, cada tarjeta nueva va al primer estado de la columna dentro de su propio tipo.
      if (add.category) {
        for (const t of created) {
          const state = stateForCategory(findType(itemTypes, t.type_id), add.category);
          if (state.id !== t.state_id) await repo.setState(t.id, state.id);
        }
      }
    });
    setText('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setText(''); }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-black/5 dark:hover:bg-white/5">
        <Plus className="size-4" />Añadir tarjeta
      </button>
    );
  }
  return (
    <div className="mt-2">
      <textarea autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        onBlur={() => { if (!text.trim()) setOpen(false); }}
        placeholder="Título… (admite mañana, @persona, !1, +etiqueta)"
        className="w-full resize-none rounded-lg border border-zinc-300 bg-white p-2 text-sm shadow-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
      <div className="mt-1 flex gap-2">
        <button type="button" onClick={() => void submit()} className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500">Añadir</button>
        <button type="button" onClick={() => { setOpen(false); setText(''); }} className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-black/5">Cancelar</button>
      </div>
    </div>
  );
}

export function TypeTabs({ value, onChange, tasks }: { value: string; onChange: (id: string) => void; tasks: Task[] }) {
  const { itemTypes } = useApp();
  return (
    <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
      {itemTypes.map((t) => {
        const n = tasks.filter((x) => x.type_id === t.id && x.status === 'todo' && !x.deleted_at).length;
        return (
          <button key={t.id} type="button" onClick={() => onChange(t.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm ${value === t.id ? 'bg-white font-medium shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}>
            <span className="size-2 rounded-full" style={{ background: t.color }} />{t.name}
            {n > 0 && <span className="text-xs text-zinc-400">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
