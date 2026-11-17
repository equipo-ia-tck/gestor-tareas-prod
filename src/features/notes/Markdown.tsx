import type { ReactNode } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { navigate } from '../../app/router';
import { Avatar } from '../../components/ui/Badges';
import { parseMarkdown, type Block, type Inline } from '../../domain/markdown';
import { nameKey } from '../../domain/text';
import type { Task } from '../../domain/types';

interface Props {
  text: string;
  /** Clic en la casilla de una acción. */
  onToggle?: (line: number, taskId: string | null) => void;
  /** Botón "→ tarea" en las acciones sin enlazar. */
  onMakeTask?: (line: number) => void;
}

/** Pinta el Markdown de una nota con sus extensiones (@persona, #proyecto, US-123, tareas enlazadas). */
export function Markdown({ text, onToggle, onMakeTask }: Props) {
  const blocks = parseMarkdown(text);
  return <div className="space-y-1 text-sm leading-relaxed">{blocks.map((b) => <BlockView key={b.line} block={b} onToggle={onToggle} onMakeTask={onMakeTask} />)}</div>;
}

function BlockView({ block: b, onToggle, onMakeTask }: { block: Block } & Omit<Props, 'text'>) {
  const { tasks } = useApp();
  const pad = { paddingLeft: `${b.indent * 1.25}rem` };
  switch (b.type) {
    case 'blank': return <div className="h-2" />;
    case 'hr': return <hr className="my-3 border-zinc-200 dark:border-zinc-700" />;
    case 'heading': {
      const cls = b.level === 1 ? 'mt-4 text-xl font-bold' : b.level === 2 ? 'mt-4 text-base font-semibold' : 'mt-3 text-sm font-semibold text-zinc-600 dark:text-zinc-300';
      return <div className={cls}><Inlines items={b.inline} /></div>;
    }
    case 'paragraph': return <p style={pad}><Inlines items={b.inline} /></p>;
    case 'quote': return <blockquote className="border-l-2 border-zinc-300 pl-3 text-zinc-600 italic dark:border-zinc-600 dark:text-zinc-400"><Inlines items={b.inline} /></blockquote>;
    case 'bullet': return <div className="flex gap-2" style={pad}><span className="text-zinc-400">•</span><span><Inlines items={b.inline} /></span></div>;
    case 'ordered': return <div className="flex gap-2" style={pad}><span className="text-zinc-400 tabular-nums">{b.n}.</span><span><Inlines items={b.inline} /></span></div>;
    case 'task': {
      const task = b.taskId ? tasks.find((t) => t.id === b.taskId) : undefined;
      const done = task ? task.status === 'done' : b.checked;
      return (
        <div className="group flex items-start gap-2" style={pad}>
          <button type="button" disabled={!onToggle} onClick={(e) => { e.stopPropagation(); onToggle?.(b.line, b.taskId); }}
            aria-label={done ? 'Marcar como pendiente' : 'Marcar como hecha'}
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-400 dark:border-zinc-500'}`}>
            {done && <Check className="size-3" />}
          </button>
          <span className={done ? 'text-zinc-400 line-through' : ''}><Inlines items={b.inline} /></span>
          {task && <TaskChip task={task} />}
          {!b.taskId && onMakeTask && b.inline.length > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onMakeTask(b.line); }}
              className="ml-1 rounded px-1 text-[11px] text-indigo-600 opacity-0 group-hover:opacity-100 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950">
              → tarea
            </button>
          )}
        </div>
      );
    }
  }
}

function TaskChip({ task }: { task: Task }) {
  const { editTask } = useApp();
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); editTask(task); }} title="Abrir la tarea"
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-indigo-50 px-1 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900/60">
      <ExternalLink className="size-2.5" />tarea
    </button>
  );
}

export function Inlines({ items }: { items: Inline[] }) {
  return <>{items.map((it, i) => <InlineView key={i} item={it} />)}</>;
}

function InlineView({ item }: { item: Inline }): ReactNode {
  const { projects, tasks, editTask } = useApp();
  switch (item.type) {
    case 'text': return item.text;
    case 'bold': return <strong className="font-semibold"><Inlines items={item.children} /></strong>;
    case 'italic': return <em><Inlines items={item.children} /></em>;
    case 'code': return <code className="rounded bg-zinc-100 px-1 font-mono text-[0.85em] dark:bg-zinc-800">{item.text}</code>;
    case 'link':
      return <a href={item.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">{item.text}</a>;
    case 'mention': {
      const name = item.name.replace(/-/g, ' ');
      return (
        <button type="button" onClick={(e) => { e.stopPropagation(); navigate({ view: 'person', name }); }}
          className="inline-flex items-center gap-1 rounded-full bg-sky-50 py-px pr-1.5 pl-0.5 align-baseline text-[0.9em] font-medium text-sky-800 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900/60">
          <Avatar name={name} size={14} />{name}
        </button>
      );
    }
    case 'project': {
      const p = projects.find((x) => nameKey(x.name) === nameKey(item.name));
      return p
        ? <button type="button" onClick={(e) => { e.stopPropagation(); navigate({ view: 'project', id: p.id }); }} className="font-medium hover:underline" style={{ color: p.color }}>#{p.name}</button>
        : <span className="text-zinc-500">#{item.name}</span>;
    }
    case 'key': {
      const t = tasks.find((x) => x.external_id === item.key);
      return t
        ? <button type="button" onClick={(e) => { e.stopPropagation(); editTask(t); }} className="rounded bg-cyan-50 px-1 font-mono text-[0.85em] text-cyan-700 hover:underline dark:bg-cyan-950 dark:text-cyan-300">{item.key}</button>
        : <span className="rounded bg-cyan-50 px-1 font-mono text-[0.85em] text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">{item.key}</span>;
    }
    case 'tasklink': return null;
  }
}
