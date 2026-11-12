import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlarmClock, AlignLeft, Users as Users2, CalendarPlus, Sun, MessageSquare, MessageSquareText, Calendar, Check, History, CheckSquare, ExternalLink, Flag, Folder, GripVertical, Hash, Link2, Plus, Repeat, Tag, Trash2, User, X,
} from 'lucide-react';
import { externalUrl } from '../domain/releases';
import { notesForTask, notesLinkingTask } from '../domain/notes';
import { TaskNotes } from '../features/notes/TaskNotes';
import { RallyTaskSection } from '../features/rally/RallyTaskSection';
import { MessageButton } from '../features/templates/MessageComposer';
import { useSync } from '../data/sync';
import { shareInfo } from '../domain/sharing';
import { spaceOf } from '../domain/spaces';
import { projectPath } from '../domain/projects';
import { useProjectOptions } from '../hooks/useProjectOptions';
import { formatReminder, quickReminders, toDatetimeLocal } from '../domain/reminders';
import { icsFileName, taskToIcs } from '../domain/icsExport';
import { ensureNotificationPermission } from '../features/reminders/notifications';
import type { ActivityEntry } from '../domain/types';
import { useApp } from '../app/AppContext';
import { repo } from '../data/services';
import { LABEL_COLORS, labelColor } from '../domain/colors';
import { formatDay } from '../domain/dates';
import { describeRule } from '../domain/recurrence';
import { fuzzyScore, nameKey } from '../domain/text';
import { TOPIC_TYPE_ID, type ChecklistItem, type Priority, type Task } from '../domain/types';
import { findType, stateOf } from '../domain/workflows';
import { isEditable } from '../features/command/CommandCenter';
import { Avatar, LabelChip, PRIORITY_COLOR, PRIORITY_LABEL, StatePill } from './ui/Badges';
import { MenuItem, Popover } from './ui/Popover';
import { DateButton } from './ui/DatePicker';

const fieldBox = 'rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800';
const inputBox = 'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-900';

/** Panel lateral con todos los campos de la tarea (al estilo Asana). Cada cambio se guarda y se puede deshacer. */
export function TaskDetailPanel() {
  const { tasks, detailId, closeDetail } = useApp();
  const task = tasks.find((t) => t.id === detailId);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !isEditable(e.target) && !document.querySelector('[role="dialog"]')) closeDetail();
    };
    // Clic fuera: se cierra. No cuenta lo que abre otra tarea (filas, tarjetas, Rally), lo que pertenece al panel aunque
    // se dibuje fuera (desplegables, diálogos), los avisos, la barra de selección ni la barra de scroll.
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (target.closest('[data-task-panel], [data-task-id], [data-opens-task], [data-rally-row], [data-popover], [role="dialog"], [data-keep-panel]')) return;
      if (e.offsetX > target.clientWidth || e.offsetY > target.clientHeight) return; // barra de scroll
      closeDetail();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [closeDetail]);

  if (!task) return null;
  return <PanelBody key={task.id} task={task} onClose={closeDetail} />;
}

function PanelBody({ task, onClose }: { task: Task; onClose: () => void }) {
  const { itemTypes, today, notes } = useApp();
  const type = findType(itemTypes, task.type_id);
  const state = stateOf(itemTypes, task);
  const update = (patch: Partial<Task>, label: string) => repo.batch(label, () => repo.updateTask(task.id, patch));

  return (
    <aside
      data-task-panel
      aria-label="Detalle de la tarea"
      // Esc dentro de un campo: primero sale del campo; un segundo Esc cierra el panel.
      onKeyDown={(e) => { if (e.key === 'Escape' && isEditable(e.target)) (e.target as HTMLElement).blur(); }}
      className="flex h-full flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => void repo.setCompleted(task.id, task.status !== 'done')}
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${task.status === 'done' ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'border-zinc-300 hover:border-emerald-500 hover:text-emerald-700 dark:border-zinc-600'}`}
        >
          <Check className="size-3.5" />{task.status === 'done' ? 'Completada' : 'Marcar como completada'}
        </button>
        {task.type_id === TOPIC_TYPE_ID ? (
          <span title="Los temas para hablar están siempre en Mi día hasta que se marcan como hablados"
            className="flex items-center gap-1 rounded-md border border-amber-400 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <Sun className="size-3.5" fill="currentColor" />En Mi día
          </span>
        ) : (
          <button type="button" onClick={() => void repo.batch(task.my_day === today ? 'Quitada de Mi día' : 'Añadida a Mi día', () => repo.updateTask(task.id, { my_day: task.my_day === today ? null : today }))}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${task.my_day === today ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'border-zinc-300 hover:border-amber-400 hover:text-amber-700 dark:border-zinc-600'}`}>
            <Sun className="size-3.5" fill={task.my_day === today ? 'currentColor' : 'none'} />{task.my_day === today ? 'En Mi día' : 'Mi día'}
          </button>
        )}
        <div className="flex-1" />
        <button type="button" title="Eliminar" onClick={() => { void repo.deleteTask(task.id); onClose(); }}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"><Trash2 className="size-4" /></button>
        <button type="button" title="Cerrar (Esc)" onClick={onClose}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* Tipo y estado */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
            {itemTypes.map((t) => (
              <button key={t.id} type="button" onClick={() => void repo.setType(task.id, t.id)}
                className={`rounded px-2 py-0.5 text-xs font-medium ${t.id === type.id ? 'text-white' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`}
                style={t.id === type.id ? { background: t.color } : undefined}>
                {t.short || t.name}
              </button>
            ))}
          </div>
          <Popover trigger={(toggle) => <StatePill state={state} onClick={toggle} />}>
            {(close) => type.states.map((s) => (
              <MenuItem key={s.id} active={s.id === state.id} onClick={() => { close(); void repo.setState(task.id, s.id); }}>
                <span className="size-2 rounded-full" style={{ background: s.color }} />{s.name}
                {s.id === state.id && <Check className="ml-auto size-3.5" />}
              </MenuItem>
            ))}
          </Popover>
        </div>

        <TitleField task={task} />
        <SharingLine task={task} />

        {/* Propiedades */}
        <dl className="mt-3 grid grid-cols-[110px_1fr] items-center gap-x-2 gap-y-1 text-sm">
          <Prop icon={<Calendar className="size-4" />} label="Fecha"><DateField task={task} /></Prop>
          <Prop icon={<AlarmClock className="size-4" />} label="Recordatorio"><ReminderField task={task} /></Prop>
          {/* Para hablar, sin Outlook, Mensaje ni ID externo. La release se quitó del panel en todos los tipos (nov 2026). */}
          {task.type_id !== TOPIC_TYPE_ID && <Prop icon={<CalendarPlus className="size-4" />} label="Outlook"><OutlookButton task={task} /></Prop>}
          {task.type_id !== TOPIC_TYPE_ID && <Prop icon={<MessageSquare className="size-4" />} label="Mensaje"><MessageButton task={task} className={fieldBox} /></Prop>}
          <Prop icon={<Folder className="size-4" />} label="Proyecto"><ProjectField task={task} /></Prop>
          {task.type_id !== TOPIC_TYPE_ID && <Prop icon={<Hash className="size-4" />} label="ID externo"><ExternalIdField task={task} /></Prop>}
          <Prop icon={<Link2 className="size-4" />} label="Enlace"><UrlField task={task} /></Prop>
          <Prop icon={<Flag className="size-4" />} label="Prioridad">
            <div className="flex gap-1">
              {([1, 2, 3, 4] as Priority[]).map((p) => (
                <button key={p} type="button" title={PRIORITY_LABEL[p]} onClick={() => void update({ priority: p }, `Prioridad ${p}`)}
                  className={`rounded-md border px-2 py-0.5 text-xs font-medium ${task.priority === p ? 'text-white' : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'}`}
                  style={task.priority === p ? { background: PRIORITY_COLOR[p], borderColor: PRIORITY_COLOR[p] } : undefined}>
                  {PRIORITY_LABEL[p]}
                </button>
              ))}
            </div>
          </Prop>
          <Prop icon={<User className="size-4" />} label="Personas"><PeopleField task={task} /></Prop>
          <Prop icon={<Tag className="size-4" />} label="Etiquetas"><LabelsField task={task} /></Prop>
          {task.recurrence_rule && (
            <Prop icon={<Repeat className="size-4" />} label="Se repite">
              <span className="flex items-center gap-2 px-2">
                {describeRule(task.recurrence_rule)}
                <button type="button" className="text-xs text-zinc-400 hover:text-red-600" onClick={() => void update({ recurrence_rule: null }, 'Recurrencia quitada')}>Quitar</button>
              </span>
            </Prop>
          )}
        </dl>

        <RallyTaskSection key={task.id} task={task} />
        <Section icon={<CheckSquare className="size-4" />} title="Pasos"><Checklist task={task} /></Section>
        <Section icon={<MessageSquareText className="size-4" />} title={`Notas · ${notesForTask(task.id, notes).length}`}>
          <NotesField task={task} />
          <TaskNotes task={task} compact />
        </Section>
        <RelatedNotes taskId={task.id} />
        <TaskHistory taskId={task.id} />

        <footer className="mt-6 space-y-0.5 border-t border-zinc-100 pt-3 text-xs text-zinc-400 dark:border-zinc-800">
          <p>Creada {new Date(task.created_at).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</p>
          {task.completed_at && <p>Completada {new Date(task.completed_at).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</p>}
          {task.due_date && task.status === 'todo' && task.due_date < today && <p className="text-amber-600">Atrasada desde {formatDay(task.due_date, today).toLowerCase()}</p>}
          {task.raw_input && task.raw_input.trim() !== task.title && <p>Texto original: <span className="font-mono">{task.raw_input}</span></p>}
        </footer>
      </div>
    </aside>
  );
}

function Prop({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">{icon}{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{icon}{title}</h3>
      {children}
    </section>
  );
}

function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

function TitleField({ task }: { task: Task }) {
  const [value, setValue] = useState(task.title);
  const ref = useAutosize(value);
  useEffect(() => setValue(task.title), [task.title]);
  const save = () => {
    const v = value.trim();
    if (v && v !== task.title) void repo.batch('Título cambiado', () => repo.updateTask(task.id, { title: v }));
    else setValue(task.title);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { setValue(task.title); e.currentTarget.blur(); } }}
      aria-label="Título"
      className={`-mx-2 w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md bg-transparent px-2 py-1 text-xl font-semibold outline-none hover:bg-zinc-50 focus:bg-zinc-50 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900 ${task.status === 'done' ? 'text-zinc-400 line-through' : ''}`}
    />
  );
}

/** Campo de texto que se edita al hacer clic y se guarda con Enter o al salir. */
function InlineText({ display, initial, placeholder, parse, onSave }: {
  display: ReactNode;
  initial: string;
  placeholder: string;
  parse?: (text: string) => { ok: boolean; preview?: string };
  onSave: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial);
  if (!editing) {
    return <button type="button" className={`${fieldBox} w-full text-left`} onClick={() => { setText(initial); setEditing(true); }}>{display}</button>;
  }
  const result = parse?.(text);
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && (!result || result.ok)) onSave(text);
  };
  return (
    <div className="flex items-center gap-2">
      <input autoFocus className={inputBox} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.preventDefault(); finish(false); } }} />
      {text && result?.preview && <span className={`shrink-0 text-xs ${result.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{result.preview}</span>}
    </div>
  );
}

function DateField({ task }: { task: Task }) {
  const { today } = useApp();
  const late = task.status === 'todo' && task.due_date && task.due_date < today;
  return (
    <DateButton
      value={task.due_date}
      align="right"
      className={`${fieldBox} w-full text-left`}
      render={(v) => (v ? <span className={late ? 'text-amber-600' : ''}>{formatDay(v, today)}</span> : <span className="text-zinc-400">Sin fecha</span>)}
      onChange={(d) => { if (d !== task.due_date) void repo.batch(d ? 'Fecha cambiada' : 'Fecha quitada', () => repo.updateTask(task.id, { due_date: d })); }}
    />
  );
}

function ExternalIdField({ task }: { task: Task }) {
  const { itemTypes } = useApp();
  const url = externalUrl(task, findType(itemTypes, task.type_id));
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <InlineText
          initial={task.external_id ?? ''}
          placeholder="US-1234, TS-55…"
          display={task.external_id ? <span className="font-mono text-xs">{task.external_id}</span> : <span className="text-zinc-400">Sin ID</span>}
          onSave={(t) => {
            const v = t.trim() || null;
            if (v !== task.external_id) void repo.batch(v ? `ID ${v}` : 'ID quitado', () => repo.updateTask(task.id, { external_id: v }));
          }}
        />
      </div>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Abrir en la herramienta externa"
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-indigo-600 dark:hover:bg-zinc-800"><ExternalLink className="size-4" /></a>
      )}
    </div>
  );
}

function UrlField({ task }: { task: Task }) {
  const { itemTypes } = useApp();
  const type = findType(itemTypes, task.type_id);
  const auto = !task.url && externalUrl(task, type);
  return (
    <InlineText
      initial={task.url ?? ''}
      placeholder="https://…"
      display={task.url
        ? <span className="block truncate text-indigo-600 dark:text-indigo-400">{task.url.replace(/^https?:\/\//, '')}</span>
        : <span className="text-zinc-400">{auto ? 'Automático desde el ID' : 'Sin enlace'}</span>}
      parse={(t) => ({ ok: !t.trim() || /^https?:\/\//i.test(t.trim()), preview: t.trim() && !/^https?:\/\//i.test(t.trim()) ? 'Empieza por https://' : '' })}
      onSave={(t) => {
        const v = t.trim() || null;
        if (v !== task.url) void repo.batch(v ? 'Enlace guardado' : 'Enlace quitado', () => repo.updateTask(task.id, { url: v }));
      }}
    />
  );
}

function ProjectField({ task }: { task: Task }) {
  const { projects, projectMap } = useApp();
  const current = task.project_id ? projectMap.get(task.project_id) : undefined;
  const [query, setQuery] = useState('');
  const options = useProjectOptions(query);
  const list = options.map((o) => o.project);
  const move = (id: string | null, name: string) => repo.batch(id ? `Movida a ${name}` : 'Proyecto quitado', () => repo.updateTask(task.id, { project_id: id }));
  return (
    <Popover width="w-64" trigger={(toggle) => (
      <button type="button" className={`${fieldBox} flex w-full items-center gap-2 text-left`} onClick={toggle}>
        {current ? <><span className="size-2.5 shrink-0 rounded-sm" style={{ background: current.color }} /><span className="truncate">{projectPath(current.id, projectMap)}</span></> : <span className="text-zinc-400">Sin proyecto</span>}
      </button>
    )}>
      {(close) => (
        <>
          <input autoFocus className={`${inputBox} mb-1`} placeholder="Buscar o crear…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (list[0]) { await move(list[0].id, list[0].name); close(); }
              else if (query.trim()) {
                await repo.batch(`Movida a ${query.trim()}`, async () => {
                  const p = await repo.createProject(query.trim());
                  await repo.updateTask(task.id, { project_id: p.id });
                });
                close();
              }
            }} />
          <div className="max-h-56 overflow-y-auto">
            {!query && <MenuItem onClick={() => { close(); void move(null, ''); }}><span className="text-zinc-400">Sin proyecto</span></MenuItem>}
            {options.map(({ project: p, depth, path }) => (
              <MenuItem key={p.id} active={p.id === task.project_id} onClick={() => { close(); void move(p.id, p.name); }}>
                <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${depth * 0.8}rem` }}>
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: p.color }} /><span className="truncate">{query ? path : p.name}</span>
                </span>
              </MenuItem>
            ))}
            {query.trim() && !projects.some((p) => nameKey(p.name) === nameKey(query)) && (
              <p className="px-2 py-1 text-xs text-zinc-400">Enter para crear «{query.trim()}»</p>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}

/** Chips con buscador para añadir (personas o etiquetas). */
function ChipsField({ values, suggestions, placeholder, renderChip, onChange, addLabel }: {
  values: string[];
  suggestions: string[];
  placeholder: string;
  renderChip: (value: string, remove: () => void) => ReactNode;
  onChange: (next: string[], label: string) => void;
  addLabel: string;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const options = useMemo(() => suggestions
    .filter((s) => !values.some((v) => nameKey(v) === nameKey(s)))
    .map((s) => ({ s, score: fuzzyScore(text, s) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score! - a.score!)
    .slice(0, 6)
    .map((x) => x.s), [suggestions, values, text]);

  const add = (v: string) => {
    const value = v.trim().replace(/^[@+#]/, '');
    if (value && !values.some((x) => nameKey(x) === nameKey(value))) onChange([...values, value], `${addLabel} ${value}`);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(options[0] && text && fuzzyScore(text, options[0]) !== null && nameKey(options[0]).startsWith(nameKey(text)) ? options[0] : text); }
    if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setText(''); }
    if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1), 'Quitado');
  };

  return (
    <div className="flex flex-wrap items-center gap-1 px-1 py-0.5">
      {values.map((v) => renderChip(v, () => onChange(values.filter((x) => x !== v), `Quitado ${v}`)))}
      {adding ? (
        <div className="relative">
          <input autoFocus className={`${inputBox} w-40`} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            onBlur={() => { if (text.trim()) add(text); setAdding(false); }} />
          {options.length > 0 && (
            <ul className="absolute z-30 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {options.map((o) => (
                <li key={o}><button type="button" onMouseDown={(e) => { e.preventDefault(); add(o); }} className="w-full px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">{o}</button></li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
          <Plus className="size-3" />Añadir
        </button>
      )}
    </div>
  );
}

function PeopleField({ task }: { task: Task }) {
  const { mentionables } = useApp();
  return (
    <ChipsField
      values={task.people}
      suggestions={mentionables}
      placeholder="Nombre…"
      addLabel="Añadida"
      onChange={(people, label) => void repo.batch(label, () => repo.updateTask(task.id, { people }))}
      renderChip={(name, remove) => (
        <span key={name} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1.5 pl-0.5 text-xs dark:bg-zinc-800">
          <Avatar name={name} size={18} />{name}
          <button type="button" onClick={remove} className="text-zinc-400 hover:text-zinc-700" aria-label={`Quitar ${name}`}>×</button>
        </span>
      )}
    />
  );
}

function LabelsField({ task }: { task: Task }) {
  const { tasks, labels, labelColors } = useApp();
  // El color de una etiqueta es común a todo el equipo: solo lo cambian los administradores.
  const { isAdmin } = useSync();
  const all = useMemo(() => [...new Set([...labels.map((l) => l.name), ...tasks.flatMap((t) => t.tags)])], [labels, tasks]);
  return (
    <ChipsField
      values={task.tags}
      suggestions={all}
      placeholder="Etiqueta…"
      addLabel="Etiqueta"
      onChange={(tags, label) => void repo.batch(label, () => repo.updateTask(task.id, { tags }))}
      renderChip={(name, remove) => !isAdmin ? <LabelChip key={name} name={name} colors={labelColors} onRemove={remove} /> : (
        <Popover key={name} width="w-auto" trigger={(toggle) => (
          <span onClick={toggle} className="cursor-pointer" title="Clic para cambiar el color"><LabelChip name={name} colors={labelColors} onRemove={remove} /></span>
        )}>
          {(close) => <ColorPalette current={labelColor(name, labelColors)} onPick={(c) => { close(); void repo.setLabelColor(name, c); }} />}
        </Popover>
      )}
    />
  );
}

export function ColorPalette({ current, onPick }: { current: string; onPick: (color: string) => void }) {
  return (
    <div className="grid grid-cols-7 gap-1 p-1">
      {LABEL_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onPick(c)} aria-label={`Color ${c}`}
          className={`size-6 rounded-full ${c === current ? 'ring-2 ring-zinc-900 ring-offset-2 dark:ring-white dark:ring-offset-zinc-900' : ''}`} style={{ background: c }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Pasos

function Checklist({ task }: { task: Task }) {
  const [text, setText] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const items = task.checklist;
  const save = (checklist: ChecklistItem[], label: string) => repo.batch(label, () => repo.updateTask(task.id, { checklist }));
  const done = items.filter((i) => i.done).length;

  const add = () => {
    const t = text.trim();
    if (!t) return;
    void save([...items, { id: crypto.randomUUID(), text: t, done: false }], 'Paso añadido');
    setText('');
  };

  function onDrop(e: DragEvent, to: number) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === to) return;
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(to, 0, moved);
    setDragIndex(null);
    void save(next, 'Pasos reordenados');
  }

  return (
    <div>
      {items.length > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
          <span className="text-xs text-zinc-500">{done}/{items.length}</span>
        </div>
      )}
      <ul>
        {items.map((item, i) => (
          <li key={item.id} draggable onDragStart={() => setDragIndex(i)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, i)}
            className={`group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${dragIndex === i ? 'opacity-40' : ''}`}>
            <GripVertical className="size-3.5 shrink-0 cursor-grab text-zinc-300 opacity-0 group-hover:opacity-100" />
            <button type="button" aria-label={item.done ? 'Desmarcar paso' : 'Completar paso'}
              onClick={() => void save(items.map((x) => (x.id === item.id ? { ...x, done: !x.done } : x)), item.done ? 'Paso pendiente' : 'Paso completado')}
              className={`flex size-4 shrink-0 items-center justify-center rounded border ${item.done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-300 dark:border-zinc-600'}`}>
              {item.done && <Check className="size-3" />}
            </button>
            <StepText item={item} onSave={(t) => void save(items.map((x) => (x.id === item.id ? { ...x, text: t } : x)), 'Paso editado')} />
            <button type="button" aria-label="Eliminar paso" onClick={() => void save(items.filter((x) => x.id !== item.id), 'Paso eliminado')}
              className="text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-600"><X className="size-3.5" /></button>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center gap-2 px-1">
        <Plus className="size-4 shrink-0 text-zinc-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Añadir paso"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          onBlur={add}
          className="w-full bg-transparent py-1 text-sm outline-none placeholder:text-zinc-400" />
      </div>
    </div>
  );
}

function StepText({ item, onSave }: { item: ChecklistItem; onSave: (text: string) => void }) {
  const [value, setValue] = useState(item.text);
  useEffect(() => setValue(item.text), [item.text]);
  return (
    <input value={value} onChange={(e) => setValue(e.target.value)}
      onBlur={() => { if (value.trim() && value !== item.text) onSave(value.trim()); else setValue(item.text); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setValue(item.text); e.currentTarget.blur(); } }}
      className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${item.done ? 'text-zinc-400 line-through' : ''}`} />
  );
}

/** Espacio de la tarea, de quién es y con quién más se comparte (cuentas en «Personas»). */
function SharingLine({ task }: { task: Task }) {
  const { user, team, owners } = useSync();
  const { projectMap, spaces } = useApp();
  const info = shareInfo(task.people, owners[`tasks:${task.id}`], user, team);
  const space = spaces.find((s) => s.id === spaceOf(task, projectMap));
  const parts = [
    space && <span key="s" className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: space.color }} />Espacio {space.name}</span>,
    info.owner && <span key="o">De {info.owner.name}</span>,
    info.with.length > 0 && <span key="w">Compartida con {info.with.map((u) => u.name).join(', ')}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sky-700 dark:text-sky-400">
      <Users2 className="size-3.5" />
      {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} aria-hidden>·</span>, p] : [p]))}
    </p>
  );
}

/**
 * Descarga la tarea como evento de calendario (.ics): al abrirlo se añade a Outlook (o al calendario
 * por defecto) con su alarma, que avisa aunque esta app esté cerrada.
 */
function OutlookButton({ task }: { task: Task }) {
  const { projectMap } = useApp();
  const ics = taskToIcs(task, { projectPath: task.project_id ? projectPath(task.project_id, projectMap) : undefined });
  if (!ics) return <span className="px-2 text-xs text-zinc-400">Ponle fecha o recordatorio para añadirla</span>;
  const download = () => {
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = icsFileName(task);
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button type="button" onClick={download} title="Descarga un evento con alarma; ábrelo y se añade a tu calendario"
      className={`${fieldBox} flex items-center gap-1.5 text-left text-indigo-600 dark:text-indigo-400`}>
      Añadir a Outlook
      <span className="text-xs text-zinc-400">({task.remind_at ? 'a la hora del recordatorio' : 'ese día a las 9:00'})</span>
    </button>
  );
}

function ReminderField({ task }: { task: Task }) {
  const [custom, setCustom] = useState('');
  const now = new Date();
  const set = async (iso: string | null, label: string) => {
    if (iso) await ensureNotificationPermission();
    await repo.batch(label, () => repo.updateTask(task.id, { remind_at: iso }));
  };
  const past = task.remind_at && task.remind_at <= now.toISOString();
  return (
    <Popover width="w-64" trigger={(toggle) => (
      <button type="button" className={`${fieldBox} flex w-full items-center gap-2 text-left`} onClick={toggle}>
        {task.remind_at
          ? <span className={past ? 'text-orange-600' : ''}>{formatReminder(task.remind_at, now, formatDay)}</span>
          : <span className="text-zinc-400">Sin aviso</span>}
      </button>
    )}>
      {(close) => (
        <>
          {quickReminders(now).map((o) => (
            <MenuItem key={o.label} onClick={() => { close(); void set(o.at, 'Recordatorio puesto'); }}>{o.label}</MenuItem>
          ))}
          <div className="mt-1 flex gap-1 border-t border-zinc-100 px-1 pt-2 dark:border-zinc-800">
            <input type="datetime-local" value={custom || (task.remind_at ? toDatetimeLocal(task.remind_at) : '')} onChange={(e) => setCustom(e.target.value)}
              className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1 text-xs dark:border-zinc-600 dark:bg-zinc-900" aria-label="Fecha y hora del aviso" />
            <button type="button" disabled={!custom} onClick={() => { close(); void set(new Date(custom).toISOString(), 'Recordatorio puesto'); }}
              className="rounded bg-indigo-600 px-2 text-xs text-white disabled:opacity-40">OK</button>
          </div>
          {task.remind_at && <MenuItem onClick={() => { close(); void set(null, 'Recordatorio quitado'); }}><span className="text-zinc-400">Quitar aviso</span></MenuItem>}
          <p className="px-2 pt-1 text-[11px] text-zinc-400">Aquí solo avisa con la app abierta. Para un aviso seguro, usa «Añadir a Outlook».</p>
        </>
      )}
    </Popover>
  );
}

const ACTIVITY_LABEL: Record<ActivityEntry['kind'], string> = {
  created: 'Creada', completed: 'Completada', reopened: 'Reabierta', postponed: 'Pospuesta',
  deleted: 'Eliminada', archived: 'Archivada', state: 'Estado',
};

/** Lo que le ha pasado a la tarea (registro de actividad). */
function TaskHistory({ taskId }: { taskId: string }) {
  const { activity, itemTypes, today } = useApp();
  const mine = activity.filter((e) => e.task_id === taskId).sort((a, b) => b.at.localeCompare(a.at));
  if (!mine.length) return null;
  const stateName = (id: string | null) => itemTypes.flatMap((t) => t.states).find((s) => s.id === id)?.name ?? id;
  const times = mine.filter((e) => e.kind === 'postponed').length;
  return (
    <Section icon={<History className="size-4" />} title={`Historial${times > 1 ? ` · pospuesta ${times} veces` : ''}`}>
      <ul className="space-y-0.5 text-xs text-zinc-500">
        {mine.slice(0, 20).map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-400">{formatDay(e.date, today)} {new Date(e.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span>
            <span>
              {ACTIVITY_LABEL[e.kind]}
              {e.kind === 'postponed' && ` de ${e.from ? formatDay(e.from, today).toLowerCase() : '—'} a ${e.to ? formatDay(e.to, today).toLowerCase() : 'sin fecha'}`}
              {e.kind === 'state' && `: ${stateName(e.from)} → ${stateName(e.to)}`}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Actas o notas de donde salió la tarea (acciones enlazadas con [[t:id]]). */
function RelatedNotes({ taskId }: { taskId: string }) {
  const { notes, today } = useApp();
  const related = notesLinkingTask(taskId, notes);
  if (!related.length) return null;
  return (
    <Section icon={<AlignLeft className="size-4" />} title="Sale de">
      <ul className="space-y-1">
        {related.map((n) => (
          <li key={n.id}><a href={`#/notes/${n.id}`} className="flex justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <span className="truncate">{n.title || 'Nota'}</span><span className="shrink-0 text-xs text-zinc-400">{formatDay(n.date, today)}</span>
          </a></li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Descripción fija de la tarea (qué es, criterios…), encima del historial de notas fechadas.
 * Vacía, se queda en un enlace "+ Descripción" para no ocupar sitio.
 */
function NotesField({ task }: { task: Task }) {
  const [value, setValue] = useState(task.notes);
  const [editing, setEditing] = useState(false);
  const ref = useAutosize(value);
  useEffect(() => setValue(task.notes), [task.notes]);
  if (!task.notes && !editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="mb-2 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
        + Descripción (qué es, criterios de aceptación…)
      </button>
    );
  }
  return (
    <div className="mb-3">
      <p className="mb-1 text-[11px] font-medium text-zinc-400">Descripción</p>
      <textarea
        ref={ref}
        autoFocus={editing && !task.notes}
        value={value}
        rows={2}
        placeholder="Qué es, criterios de aceptación, enlaces…"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value !== task.notes) void repo.batch('Descripción guardada', () => repo.updateTask(task.id, { notes: value }));
        }}
        className="w-full resize-none rounded-md border border-transparent bg-zinc-50 px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-indigo-500 dark:bg-zinc-900"
      />
    </div>
  );
}
