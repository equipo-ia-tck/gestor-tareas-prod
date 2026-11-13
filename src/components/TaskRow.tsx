import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { formatDay, formatMinutes } from '../domain/dates';
import { AlignLeft, ChevronRight, Repeat, Sun } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { describeRule } from '../domain/recurrence';
import { TOPIC_TYPE_ID, type ISODate, type Project, type Task } from '../domain/types';
import { findType, stateOf } from '../domain/workflows';
import { AvatarStack, ChecklistProgress, ExternalChip, LabelChip, PostponedChip, PRIORITY_COLOR, PriorityFlag, ReleaseChip, ReminderChip, StatePill, TypeBadge } from './ui/Badges';
import { useSelection, type EditableField } from '../features/selection/SelectionContext';
import { useTaskActions } from '../hooks/useTaskActions';
import { setDraggedTasks } from '../hooks/useTaskDrop';
import { FieldEditor } from './FieldEditor';


interface Props {
  task: Task;
  today: ISODate;
  projects: Map<string, Project>;
  onEdit: (task: Task) => void;
  hideDate?: boolean;
  hideProject?: boolean;
  contextProjectId?: string;
  /** Botones extra a la derecha (p. ej. "Hoy" en atrasadas). */
  extra?: ReactNode;
}

const INTERACTIVE = 'button, input, select, textarea, a, [role="listbox"]';

/**
 * Fila de tarea. Clic selecciona (Shift: rango, Cmd/Ctrl: añadir), doble clic edita el campo
 * bajo el ratón, se puede arrastrar (con toda la selección) a días, proyectos o la bandeja.
 */
export function TaskRow({ task, today, projects, onEdit, hideDate, hideProject: hideAll, contextProjectId, extra }: Props) {
  const hideProject = hideAll || (contextProjectId !== undefined && task.project_id === contextProjectId);
  const { selected, focused, editing, click, startEdit, stopEdit, targetsFor } = useSelection();
  const { toggleDone, remove, update, toggleMyDay } = useTaskActions();
  const { itemTypes, labelColors, detailId } = useApp();
  const type = findType(itemTypes, task.type_id);
  const state = stateOf(itemTypes, task);
  // El estado solo se muestra cuando aporta algo: tipos con flujo propio o tareas que no están "por hacer".
  const showState = type.short !== '' || (state.category !== 'todo' && state.category !== 'done');
  const done = task.status === 'done';
  const project = task.project_id ? projects.get(task.project_id) : undefined;
  const late = !done && task.due_date !== null && task.due_date < today;
  const isSelected = selected.has(task.id);
  const isFocused = focused === task.id;
  const editField = editing?.id === task.id ? editing.field : null;

  function onClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    click(task.id, e);
    // Clic normal: además abre el panel de detalle. Con Cmd/Ctrl o Shift solo se selecciona (selección múltiple).
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) onEdit(task);
  }

  function onDoubleClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    const field = (e.target as HTMLElement).closest<HTMLElement>('[data-field]')?.dataset.field as EditableField | undefined;
    startEdit(task.id, field ?? 'title');
  }

  const chip = (field: EditableField, content: ReactNode, className = '') => (
    <span data-field={field} title="Doble clic para editar" className={`cursor-default rounded px-0.5 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 ${className}`}>
      {content}
    </span>
  );

  return (
    <li
      data-task-id={task.id}
      aria-selected={isSelected}
      draggable={!editField}
      onDragStart={(e) => setDraggedTasks(e, targetsFor(task.id).map((t) => t.id))}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`group flex items-start gap-3 border-b border-zinc-100 px-2 py-2 select-none last:border-0 dark:border-zinc-800/80
        ${isSelected || detailId === task.id ? 'bg-indigo-50 dark:bg-indigo-950/50' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'}
        ${isFocused ? 'shadow-[inset_2px_0_0_0] shadow-indigo-500' : ''}`}
      style={project && !hideProject ? { borderLeft: `3px solid ${project.color}` } : undefined}
    >
      <button
        aria-label={done ? 'Marcar como pendiente' : 'Completar'}
        onClick={() => void toggleDone(isSelected ? targetsFor(task.id) : [task])}
        className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors ${done ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-300 hover:bg-emerald-50 dark:border-zinc-600 dark:hover:bg-emerald-950'}`}
        style={done ? undefined : { borderColor: task.priority < 4 ? PRIORITY_COLOR[task.priority] : undefined }}
      >
        {done ? <span className="text-[10px] leading-none text-white">✓</span> : <span className="text-[10px] leading-none text-emerald-500 opacity-0 group-hover:opacity-60">✓</span>}
      </button>

      <div className="min-w-0 flex-1">
        {editField === 'title' ? (
          <TitleEditor task={task} onSave={(title) => { stopEdit(); if (title && title !== task.title) void update([task], { title }, 'Título cambiado'); }} onCancel={stopEdit} />
        ) : (
          <div data-field="title" className={`flex items-center gap-1.5 text-sm ${done ? 'text-zinc-400 line-through' : ''}`}>
            <TypeBadge type={type} />
            <span className="truncate">{task.title || <em className="text-zinc-400">Sin título</em>}</span>
            <PriorityFlag priority={task.priority} />
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          {(task.my_day === today || task.type_id === TOPIC_TYPE_ID) && !done && <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-600"><Sun className="size-3" />Mi día</span>}
          {showState && <StatePill state={state} />}
          <ExternalChip task={task} type={type} />
          <ReleaseChip releaseId={task.release_id} />
          {!done && <ReminderChip at={task.remind_at} />}
          {!done && <PostponedChip taskId={task.id} />}
          {!hideDate && task.due_date && chip('date', formatDay(task.due_date, today), late ? 'font-medium text-amber-600 dark:text-amber-400' : '')}
          {!hideProject && project && chip('project', <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: project.color }} />{project.name}</span>)}
          {task.tags.length > 0 && chip('tags', <span className="inline-flex flex-wrap gap-1">{task.tags.map((t) => <LabelChip key={t} name={t} colors={labelColors} small />)}</span>)}
          {task.estimated_minutes ? chip('estimate', `~${formatMinutes(task.estimated_minutes)}`) : null}
          <ChecklistProgress items={task.checklist} />
          {task.recurrence_rule && <span title={describeRule(task.recurrence_rule)}><Repeat className="size-3" /></span>}
          {task.notes && <span title={task.notes}><AlignLeft className="size-3" /></span>}
        </div>
        {editField && editField !== 'title' && (
          <FieldEditor task={task} field={editField} targets={targetsFor(task.id)} onClose={stopEdit} />
        )}
      </div>

      {task.people.length > 0 && (
        <span data-field="people" className="mt-0.5 shrink-0" title="Doble clic para editar"><AvatarStack names={task.people} /></span>
      )}
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {extra}
        <button aria-label={task.my_day === today ? 'Quitar de Mi día' : 'Añadir a Mi día'} title={task.my_day === today ? 'Quitar de Mi día (A)' : 'Añadir a Mi día (A)'}
          onClick={() => void toggleMyDay(isSelected ? targetsFor(task.id) : [task], today)}
          className={`rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-700 ${task.my_day === today ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500'}`}>
          <Sun className="size-4" fill={task.my_day === today ? 'currentColor' : 'none'} />
        </button>
        <button aria-label="Abrir detalle" title="Abrir detalle (E)" onClick={() => onEdit(task)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200">
          <ChevronRight className="size-4" />
        </button>
        <button aria-label="Eliminar" title="Eliminar (Supr)" onClick={() => void remove(isSelected ? targetsFor(task.id) : [task])}
          className="rounded px-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-700">
          ×
        </button>
      </div>
    </li>
  );
}

function TitleEditor({ task, onSave, onCancel }: { task: Task; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(task.title);
  // Evita que el blur al desmontar guarde después de cancelar con Esc.
  const closed = useRef(false);
  const finish = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (save) onSave(value.trim()); else onCancel();
  };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onFocus={(e) => e.currentTarget.select()}
      className="w-full rounded border border-indigo-400 bg-white px-1 text-sm outline-none ring-1 ring-indigo-400 dark:bg-zinc-900"
    />
  );
}
