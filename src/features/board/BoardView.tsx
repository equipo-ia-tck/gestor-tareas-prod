import { useState, type ReactNode } from 'react';
import { Bookmark, Check, ChevronDown, Search, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { Section, TaskList } from '../../components/TaskList';
import { MenuItem, Popover } from '../../components/ui/Popover';
import { repo } from '../../data/services';
import { activeFilterCount, applyFilter, EMPTY_FILTER, groupTasks } from '../../domain/filters';
import { fuzzyScore } from '../../domain/text';
import type { DueFilter, GroupBy, NewTask, SavedView, StateCategory, Task, TaskFilter } from '../../domain/types';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useProjectOptions } from '../../hooks/useProjectOptions';
import { ViewHeader } from '../views/ViewHeader';
import { useWideLayout } from '../../app/Layout';
import { ViewSwitcher, type DisplayMode } from '../../components/ui/ViewSwitcher';
import { RallyBoard } from './Board';

const CATEGORIES: { value: StateCategory; label: string; color: string }[] = [
  { value: 'todo', label: 'Por hacer', color: '#94a3b8' },
  { value: 'blocked', label: 'Bloqueado', color: '#ef4444' },
  { value: 'doing', label: 'En curso', color: '#3b82f6' },
  { value: 'done', label: 'Terminado', color: '#22c55e' },
  { value: 'accepted', label: 'Accepted', color: '#047857' },
];
const DUE: { value: DueFilter; label: string }[] = [
  { value: 'any', label: 'Cualquier fecha' }, { value: 'overdue', label: 'Atrasadas' }, { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Próximos 7 días' }, { value: 'has', label: 'Con fecha' }, { value: 'none', label: 'Sin fecha' },
];
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'type', label: 'Tipo' }, { value: 'state', label: 'Estado' }, { value: 'project', label: 'Proyecto' },
  { value: 'person', label: 'Persona' }, { value: 'due', label: 'Fecha' }, { value: 'none', label: 'Sin agrupar' },
];

/** Filtro del tablero guardado en localStorage con `key` (el Tablero general o el de cada proyecto). */
export function useBoardFilter(key: string) {
  const [stored, setStored] = usePersistentState<TaskFilter>(key, EMPTY_FILTER);
  const filter: TaskFilter = { ...EMPTY_FILTER, ...stored };
  const set = (patch: Partial<TaskFilter>) => { setStored({ ...filter, ...patch }); };
  return { filter, set, setStored };
}

export function boardSubtitle(mode: DisplayMode, count: number, includeDone: boolean) {
  return mode === 'board'
    ? 'Las 7 columnas de Rally, en su orden, para todos los tipos. Al soltar una tarjeta enlazada se mueve también en Rally.'
    : `${count} elemento${count === 1 ? '' : 's'}${includeDone ? ' (con completadas)' : ''}`;
}

/**
 * Tablero: todas las tareas, US, TS y temas en un solo sitio, con filtros combinables, vistas
 * guardadas y dos modos (tablero kanban o lista agrupada). El de cada proyecto usa los mismos `BoardControls` y
 * `BoardContent` con sus tareas.
 */
export function BoardView() {
  useWideLayout(true);
  const { tasks, allProjects, itemTypes, settings, today } = useApp();
  const { filter, set, setStored } = useBoardFilter('board-filter');
  const [viewId, setViewId] = usePersistentState('board-view', '');
  const [mode, setMode] = usePersistentState<DisplayMode>('board-mode', 'board');

  const results = applyFilter(tasks, filter, { today, projects: allProjects, types: itemTypes });
  const views = settings.saved_views;
  const current = views.find((v) => v.id === viewId);
  const dirty = current ? JSON.stringify({ ...EMPTY_FILTER, ...current.filter }) !== JSON.stringify(filter) : activeFilterCount(filter) > 0;

  const openView = (v: SavedView | null) => { setViewId(v?.id ?? ''); setStored(v ? { ...EMPTY_FILTER, ...v.filter } : EMPTY_FILTER); };
  const saveViews = (next: SavedView[]) => void repo.updateSettings({ saved_views: next });

  return (
    <>
      <ViewHeader
        title="Tablero"
        subtitle={boardSubtitle(mode, results.length, filter.includeDone)}
        actions={<ViewSwitcher value={mode} onChange={setMode} />}
      />

      {/* Vistas guardadas */}
      <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        <ViewTab active={!current} onClick={() => openView(null)}>Todo</ViewTab>
        {views.map((v) => (
          <ViewTab key={v.id} active={v.id === viewId} onClick={() => openView(v)}
            onRemove={() => { saveViews(views.filter((x) => x.id !== v.id)); if (v.id === viewId) openView(null); }}>
            {v.name}
          </ViewTab>
        ))}
        <span className="flex-1" />
        {dirty && current && (
          <button type="button" onClick={() => saveViews(views.map((v) => (v.id === current.id ? { ...v, filter } : v)))}
            className="rounded-md px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950">Guardar cambios</button>
        )}
        {dirty && <SaveAs onSave={(name) => { const v = { id: crypto.randomUUID(), name, filter }; saveViews([...views, v]); setViewId(v.id); }} />}
      </div>

      <BoardControls tasks={tasks} filter={filter} set={set} reset={() => setStored({ ...EMPTY_FILTER, groupBy: filter.groupBy })}
        mode={mode} />
      <BoardContent tasks={tasks} filter={filter} mode={mode} />
    </>
  );
}

/**
 * Interruptores por tipo y filtros (texto, estado, proyecto, persona, etiqueta, release, fecha), «Como en Rally / Por
 * grupo» y agrupar. `projectIds`: proyectos que se pueden elegir (en un proyecto, él y sus subproyectos; con uno solo no
 * se muestra el filtro).
 */
export function BoardControls({ tasks, filter, set, reset, mode, projectIds }: {
  tasks: Task[];
  filter: TaskFilter;
  set: (patch: Partial<TaskFilter>) => void;
  reset: () => void;
  mode: DisplayMode;
  projectIds?: Set<string>;
}) {
  const { itemTypes, labels, releases, mentionables } = useApp();
  const tags = [...new Set([...labels.map((l) => l.name), ...tasks.flatMap((t) => t.tags)])].sort((a, b) => a.localeCompare(b, 'es'));
  const people = projectIds ? [...new Set(tasks.flatMap((t) => t.people))].sort((a, b) => a.localeCompare(b, 'es')) : mentionables;
  const ownReleases = projectIds ? releases.filter((r) => tasks.some((t) => t.release_id === r.id)) : releases;
  return (
    <>
      {/* Qué tipos ver */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {itemTypes.map((t) => {
          const on = filter.types.includes(t.id);
          const n = tasks.filter((x) => x.type_id === t.id && x.status === 'todo' && !x.deleted_at).length;
          return (
            <button key={t.id} type="button" aria-pressed={on}
              onClick={() => set({ types: on ? filter.types.filter((x) => x !== t.id) : [...filter.types, t.id] })}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${on ? 'font-medium text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300'}`}
              style={on ? { background: t.color, borderColor: t.color } : undefined}>
              {on ? <Check className="size-3.5" /> : <span className="size-2 rounded-full" style={{ background: t.color }} />}
              {t.name}<span className={on ? 'text-white/80' : 'text-zinc-400'}>{n}</span>
            </button>
          );
        })}
        {filter.types.length > 0 && <button type="button" onClick={() => set({ types: [] })} className="text-xs text-zinc-500 hover:underline">ver todos los tipos</button>}
      </div>

      {/* Resto de filtros */}
      <div className="mb-5 flex flex-wrap items-center gap-1.5 text-sm">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input value={filter.text} onChange={(e) => set({ text: e.target.value })} placeholder="Filtrar…"
            className="w-44 rounded-md border border-zinc-200 bg-white py-1 pr-2 pl-7 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
        <Multi label="Estado" selected={filter.categories} onChange={(v) => set({ categories: v as StateCategory[] })}
          options={CATEGORIES.map((c) => ({ value: c.value, label: c.label, color: c.color }))} />
        {(!projectIds || projectIds.size > 1) && <ProjectMulti selected={filter.projects} onChange={(v) => set({ projects: v })} only={projectIds} />}
        <Multi label="Persona" selected={filter.people} onChange={(v) => set({ people: v })} searchable
          options={people.map((p) => ({ value: p, label: p }))} />
        <Multi label="Etiqueta" selected={filter.tags} onChange={(v) => set({ tags: v })} searchable
          options={tags.map((t) => ({ value: t, label: t }))} />
        {ownReleases.length > 0 && (
          <Multi label="Release" selected={filter.releases} onChange={(v) => set({ releases: v })}
            options={ownReleases.map((r) => ({ value: r.id, label: r.name }))} />
        )}
        <Single label="Fecha" value={filter.due} options={DUE} onChange={(v) => set({ due: v as DueFilter })} />
        {mode === 'list' && (
          <label className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700">
            <input type="checkbox" checked={filter.includeDone} onChange={(e) => set({ includeDone: e.target.checked })} />Completadas
          </label>
        )}
        <span className="flex-1" />
        {mode === 'list' && <Single label="Agrupar" value={filter.groupBy} options={GROUPS} onChange={(v) => set({ groupBy: v as GroupBy })} />}
        {activeFilterCount(filter) > 0 && (
          <button type="button" onClick={reset} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-600">
            <X className="size-3.5" />Limpiar
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Tablero (de un tipo, «Como en Rally» o por grupo) o lista agrupada de `tasks` con el filtro. Las tarjetas nuevas
 * heredan `defaults` y, si el filtro tiene un solo proyecto o una sola release, esos.
 */
export function BoardContent({ tasks, filter, mode, defaults, showProject = true }: {
  tasks: Task[];
  filter: TaskFilter;
  mode: DisplayMode;
  defaults?: Partial<NewTask>;
  showProject?: boolean;
}) {
  const { allProjects, itemTypes, today, projectMap, editTask } = useApp();
  const ctx = { today, projects: allProjects, types: itemTypes };
  const results = applyFilter(tasks, filter, ctx);
  // En el tablero la columna "hecho" siempre está (con las completadas recientes).
  const boardTasks = applyFilter(tasks, { ...filter, includeDone: true }, ctx);
  const cardDefaults = {
    ...defaults,
    ...(filter.projects.length === 1 ? { project_id: filter.projects[0] } : {}),
    ...(filter.releases.length === 1 ? { release_id: filter.releases[0] } : {}),
  };
  const groups = groupTasks(results, filter.groupBy, ctx);
  // Todas las vistas (un tipo, varios o todos) usan las 7 columnas de Rally, a petición de la usuaria (nov 2026).
  if (mode === 'board') return <RallyBoard tasks={boardTasks} defaults={cardDefaults} showProject={showProject} />;
  return (
    <>
      {results.length === 0 && <p className="text-sm text-zinc-400">Nada coincide con estos filtros.</p>}
      {groups.map((g) => (
        <Section key={g.key} title={<span className="inline-flex items-center gap-1.5">{g.color && <span className="size-2 rounded-full" style={{ background: g.color }} />}{g.label} · {g.tasks.length}</span>}>
          <TaskList tasks={g.tasks} today={today} projects={projectMap} onEdit={editTask} />
        </Section>
      ))}
    </>
  );
}

function ViewTab({ active, onClick, onRemove, children }: { active: boolean; onClick: () => void; onRemove?: () => void; children: ReactNode }) {
  return (
    <span className={`group flex items-center rounded-md text-sm ${active ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}>
      <button type="button" onClick={onClick} className="flex items-center gap-1 px-2.5 py-1">{onRemove && <Bookmark className="size-3" />}{children}</button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Eliminar vista" className="pr-1.5 opacity-0 group-hover:opacity-70 hover:opacity-100"><X className="size-3" /></button>
      )}
    </span>
  );
}

function SaveAs({ onSave }: { onSave: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Popover align="right" width="w-60" trigger={(toggle) => (
      <button type="button" onClick={toggle} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
        <Bookmark className="size-3.5" />Guardar vista
      </button>
    )}>
      {(close) => (
        <form className="p-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSave(name.trim()); setName(''); close(); } }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre (p. ej. QA sprint 14)"
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
        </form>
      )}
    </Popover>
  );
}

interface Opt { value: string; label: string; color?: string; depth?: number }

function FilterButton({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${count ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300' : 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'}`}>
      {label}{count > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">{count}</span>}<ChevronDown className="size-3" />
    </button>
  );
}

function Multi({ label, options, selected, onChange, searchable }: {
  label: string; options: Opt[]; selected: string[]; onChange: (v: string[]) => void; searchable?: boolean;
}) {
  const [q, setQ] = useState('');
  const shown = q ? options.filter((o) => fuzzyScore(q, o.label) !== null) : options;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <Popover width="w-60" trigger={(t) => <FilterButton label={label} count={selected.length} onClick={t} />}>
      {() => (
        <>
          {searchable && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…"
              className="mb-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none dark:border-zinc-600 dark:bg-zinc-900" />
          )}
          <div className="max-h-64 overflow-y-auto">
            {shown.map((o) => (
              <MenuItem key={o.value} onClick={() => toggle(o.value)} active={selected.includes(o.value)}>
                <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${selected.includes(o.value) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-zinc-300 dark:border-zinc-600'}`}>
                  {selected.includes(o.value) && <Check className="size-3" />}
                </span>
                <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${(o.depth ?? 0) * 0.8}rem` }}>
                  {o.color && <span className="size-2 shrink-0 rounded-full" style={{ background: o.color }} />}
                  <span className="truncate">{o.label}</span>
                </span>
              </MenuItem>
            ))}
            {!shown.length && <p className="px-2 py-1 text-xs text-zinc-400">Sin opciones.</p>}
          </div>
          {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Quitar selección</button>}
        </>
      )}
    </Popover>
  );
}

function ProjectMulti({ selected, onChange, only }: { selected: string[]; onChange: (v: string[]) => void; only?: Set<string> }) {
  const all = useProjectOptions('');
  const opts = only ? all.filter((o) => only.has(o.project.id)) : all;
  return (
    <Multi label="Proyecto" selected={selected} onChange={onChange}
      options={opts.map((o) => ({ value: o.project.id, label: o.project.name, color: o.project.color, depth: o.depth }))} />
  );
}

function Single({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value);
  return (
    <Popover width="w-48" trigger={(t) => (
      <button type="button" onClick={t} className="flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
        {label}: <span className="font-medium">{current?.label}</span><ChevronDown className="size-3" />
      </button>
    )}>
      {(close) => options.map((o) => (
        <MenuItem key={o.value} active={o.value === value} onClick={() => { close(); onChange(o.value); }}>
          {o.label}{o.value === value && <Check className="ml-auto size-3.5" />}
        </MenuItem>
      ))}
    </Popover>
  );
}
