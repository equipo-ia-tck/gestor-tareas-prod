import { AlarmClock, CheckSquare, Flag, Rocket, Undo2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { externalUrl } from '../../domain/releases';
import type { Task } from '../../domain/types';
import { colorFor, initials, labelColor, textOn, tint } from '../../domain/colors';
import type { ChecklistItem, ItemType, Priority, WorkflowState } from '../../domain/types';

export const PRIORITY_COLOR: Record<Priority, string> = { 1: '#ef4444', 2: '#f97316', 3: '#3b82f6', 4: '#a1a1aa' };
export const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Urgente', 2: 'Alta', 3: 'Media', 4: 'Normal' };

/** Círculo con iniciales y color estable por persona. */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const color = colorFor(name);
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-white dark:ring-zinc-900"
      style={{ width: size, height: size, background: color, color: textOn(color), fontSize: size * 0.42 }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 3, size = 20 }: { names: string[]; max?: number; size?: number }) {
  if (!names.length) return null;
  const shown = names.slice(0, max);
  return (
    <span className="inline-flex -space-x-1.5" title={names.join(', ')}>
      {shown.map((n) => <Avatar key={n} name={n} size={size} />)}
      {names.length > max && (
        <span className="inline-flex items-center justify-center rounded-full bg-zinc-200 text-[9px] font-semibold text-zinc-600 ring-2 ring-white dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-900"
          style={{ width: size, height: size }}>+{names.length - max}</span>
      )}
    </span>
  );
}

export function LabelChip({ name, colors, onRemove, small }: {
  name: string;
  colors: Map<string, string>;
  onRemove?: () => void;
  small?: boolean;
}) {
  const color = labelColor(name, colors);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${small ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs'}`}
      style={{ background: tint(color, 0.18), color }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {name}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Quitar ${name}`} className="opacity-60 hover:opacity-100">×</button>}
    </span>
  );
}

export function StatePill({ state, onClick }: { state: WorkflowState; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ background: tint(state.color, 0.18), color: state.color }}
    >
      <span className="size-1.5 rounded-full" style={{ background: state.color }} />
      {state.name}
    </Tag>
  );
}

export function TypeBadge({ type }: { type: ItemType }) {
  if (!type.short) return null;
  return (
    <span className="rounded px-1 text-[10px] font-bold tracking-wide text-white" style={{ background: type.color }} title={type.name}>
      {type.short}
    </span>
  );
}

export function PriorityFlag({ priority, showNormal }: { priority: Priority; showNormal?: boolean }) {
  if (priority === 4 && !showNormal) return null;
  return <Flag className="size-3.5 shrink-0" style={{ color: PRIORITY_COLOR[priority] }} fill={priority < 4 ? PRIORITY_COLOR[priority] : 'none'} aria-label={`Prioridad ${PRIORITY_LABEL[priority]}`} />;
}

export function ChecklistProgress({ items }: { items: ChecklistItem[] }) {
  if (!items.length) return null;
  const done = items.filter((i) => i.done).length;
  const complete = done === items.length;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] ${complete ? 'text-emerald-600 dark:text-emerald-400' : ''}`} title={`${done} de ${items.length} pasos`}>
      <CheckSquare className="size-3" />{done}/{items.length}
    </span>
  );
}

/** ID externo (US-1234); enlaza a la herramienta si hay URL o plantilla. */
export function ExternalChip({ task, type }: { task: Pick<Task, 'external_id' | 'url'>; type: ItemType }) {
  if (!task.external_id) return null;
  const url = externalUrl(task, type);
  const cls = 'rounded bg-cyan-50 px-1 font-mono text-[10px] text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300';
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className={`${cls} hover:underline`} title="Abrir en la herramienta externa">{task.external_id}</a>
    : <span className={cls}>{task.external_id}</span>;
}

export function ReleaseChip({ releaseId }: { releaseId: string | null }) {
  const { releaseMap } = useApp();
  const r = releaseId ? releaseMap.get(releaseId) : undefined;
  if (!r) return null;
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-lime-50 px-1 text-[10px] font-medium text-lime-800 dark:bg-lime-950 dark:text-lime-300" title={`Release ${r.name}`}>
      <Rocket className="size-2.5" />{r.name}
    </span>
  );
}

/** Hora del aviso si está pendiente. */
export function ReminderChip({ at }: { at: string | null }) {
  if (!at) return null;
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const label = today ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] text-orange-600 dark:text-orange-400" title={`Aviso: ${d.toLocaleString('es-ES')}`}>
      <AlarmClock className="size-3" />{label}
    </span>
  );
}

/** "Pospuesta 3×": a partir de dos veces, para que se note lo que se va arrastrando. */
export function PostponedChip({ taskId }: { taskId: string }) {
  const { postponed } = useApp();
  const n = postponed.get(taskId) ?? 0;
  if (n < 2) return null;
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300" title={`Pospuesta ${n} veces`}>
      <Undo2 className="size-2.5" />{n}×
    </span>
  );
}
