import { useState, type FormEvent, type ReactNode } from 'react';
import { Calendar, ChevronDown, ChevronRight, ClipboardCheck, FolderOpen, History, Plus, Inbox, KanbanSquare, Layers, NotebookPen, Settings, Sun, Users, type LucideIcon } from 'lucide-react';
import { Avatar } from '../components/ui/Badges';
import { useApp } from './AppContext';
import { repo } from '../data/services';
import { useSync } from '../data/sync';
import { useTaskActions } from '../hooks/useTaskActions';
import { usePersistentState } from '../hooks/usePersistentState';
import { projectTree, withDescendants, type ProjectNode } from '../domain/projects';
import { groupPeople, peopleDirectory, type PersonEntry } from '../domain/people';
import type { PersonGroup } from '../domain/types';
import { createGroup, movePersonToGroup, setDraggedPerson, usePersonDrop } from '../features/views/groups';
import { useRallyOwners } from '../features/rally/rallyStore';
import { dropHighlight, useTaskDrop } from '../hooks/useTaskDrop';
import { routeHref, type Route } from './router';
import { inboxTasks, myDayTasks, overdueTasks, tasksDueOn } from '../domain/selectors';
import { isActive } from '../domain/selectors';

function NavItem({ href, active, children, count, dot, icon: Icon, lead, onDropTasks, indent = 0 }: {
  href: string; active: boolean; children: ReactNode; count?: number; dot?: string;
  icon?: LucideIcon; lead?: ReactNode;
  onDropTasks?: (ids: string[]) => void;
  indent?: number;
}) {
  const { over, dropProps } = useTaskDrop(onDropTasks);
  return (
    <a
      href={href}
      {...dropProps}
      style={indent ? { paddingLeft: `${0.5 + indent * 0.9}rem` } : undefined}
      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${over ? dropHighlight : active ? 'bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60'}`}
    >
      {Icon && <Icon className={`size-4 shrink-0 ${active ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-400'}`} />}
      {dot && <span className="ml-1 size-2.5 shrink-0 rounded-sm" style={{ background: dot }} />}
      {lead}
      <span className="flex-1 truncate">{children}</span>
      {count ? <span className="text-xs text-zinc-400">{count}</span> : null}
    </a>
  );
}

const Heading = ({ href, children, action }: { href?: string; children: ReactNode; action?: ReactNode }) => (
  <div className="mt-5 mb-1 flex items-center px-2">
    {href
      ? <a href={href} className="flex-1 text-xs font-semibold tracking-wide text-zinc-400 uppercase hover:text-zinc-600 dark:hover:text-zinc-200">{children}</a>
      : <span className="flex-1 text-xs font-semibold tracking-wide text-zinc-400 uppercase">{children}</span>}
    {action}
  </div>
);

/** "+" junto a Proyectos: crea un proyecto y lo abre. */
/** "+" del título Proyectos; el cuadro para escribir el nombre aparece en su propia línea, debajo. */
function NewProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  async function create(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) {
      const p = await repo.createProject(name.trim());
      window.location.hash = routeHref({ view: 'project', id: p.id });
    }
    onDone();
  }
  return (
    <form onSubmit={create} className="mb-1 px-2">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del proyecto y Enter"
        onBlur={() => { if (!name.trim()) onDone(); }} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}
        className="w-full rounded-md border border-indigo-400 bg-white px-2 py-1 text-sm outline-none dark:bg-zinc-900" />
    </form>
  );
}

/** Proyecto en la barra lateral, con sus subproyectos plegables. */
function ProjectNav({ node, route }: { node: ProjectNode; route: Route }) {
  const { tasks, projects } = useApp();
  const { moveIds } = useTaskActions();
  const [collapsed, setCollapsed] = usePersistentState<boolean>(`sidebar-collapsed:${node.project.id}`, false);
  const p = node.project;
  const ids = withDescendants(p.id, projects);
  const count = tasks.filter((t) => t.project_id && ids.has(t.project_id) && isActive(t)).length;
  return (
    <>
      <div className="group/proj relative">
        {node.children.length > 0 && (
          <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Desplegar' : 'Plegar'}
            className="absolute top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            style={{ left: `${node.depth * 0.9 - 0.05}rem` }}>
            {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
        <NavItem
          href={routeHref({ view: 'project', id: p.id })}
          active={route.view === 'project' && route.id === p.id}
          dot={p.color}
          indent={node.depth}
          count={count}
          onDropTasks={(taskIds) => void moveIds(taskIds, { project_id: p.id }, `Movida a ${p.name}`)}
        >
          {p.name}
        </NavItem>
      </div>
      {!collapsed && node.children.map((c) => <ProjectNav key={c.project.id} node={c} route={route} />)}
    </>
  );
}

/** Vistas de uso ocasional, plegadas para no ocupar sitio. */
function MoreSection({ route }: { route: Route }) {
  const [open, setOpen] = usePersistentState('sidebar-more', false);
  const active = ['log', 'review'].includes(route.view);
  const show = open || active;
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)}
        className="mt-5 mb-1 flex items-center gap-1 px-2 text-left text-xs font-semibold tracking-wide text-zinc-400 uppercase hover:text-zinc-600 dark:hover:text-zinc-200">
        {show ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Más
      </button>
      {show && (
        <>
          <NavItem icon={ClipboardCheck} href={routeHref({ view: 'review' })} active={route.view === 'review'}>Revisión semanal</NavItem>
          <NavItem icon={History} href={routeHref({ view: 'log' })} active={route.view === 'log'}>Registro</NavItem>
        </>
      )}
    </>
  );
}

export function Sidebar({ route }: { route: Route }) {
  const { tasks, projects, today } = useApp();
  const [addingProject, setAddingProject] = useState(false);
  const is = (v: Route['view']) => route.view === v;
  const { moveIds } = useTaskActions();
  return (
    <nav className="flex h-full flex-col overflow-y-auto border-r border-zinc-200 bg-zinc-100/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="mb-4 flex items-center gap-2 px-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">✓</span>
        <span className="text-sm font-semibold">Tareas</span>
      </div>
      <NavItem icon={Sun} href={routeHref({ view: 'today' })} active={is('today')} count={new Set([...tasksDueOn(tasks, today), ...overdueTasks(tasks, today), ...myDayTasks(tasks, today)].map((t) => t.id)).size}
        onDropTasks={(ids) => void moveIds(ids, { due_date: today }, 'Movida a hoy')}>Hoy</NavItem>
      <NavItem icon={Inbox} href={routeHref({ view: 'inbox' })} active={is('inbox')} count={inboxTasks(tasks).length}
        onDropTasks={(ids) => void moveIds(ids, { due_date: null, project_id: null }, 'Movida a la bandeja')}>Bandeja</NavItem>
      <NavItem icon={KanbanSquare} href={routeHref({ view: 'board' })} active={is('board') || is('all')}>Tablero</NavItem>
      <NavItem icon={Calendar} href={routeHref({ view: 'calendar' })} active={is('calendar') || is('week')}>Calendario</NavItem>
      <NavItem icon={NotebookPen} href={routeHref({ view: 'notes' })} active={is('notes')}>Notas</NavItem>
      <NavItem icon={Layers} href={routeHref({ view: 'rally' })} active={is('rally')}>Rally</NavItem>

      <Heading action={
        <button type="button" onClick={() => setAddingProject(true)} title="Nuevo proyecto" className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700">
          <Plus className="size-3.5" />
        </button>
      }><FolderOpen className="mr-1.5 inline size-3.5" />Proyectos</Heading>
      {addingProject && <NewProjectForm onDone={() => setAddingProject(false)} />}
      {projectTree(projects).map((node) => <ProjectNav key={node.project.id} node={node} route={route} />)}
      {projects.length === 0 && <p className="px-2 text-xs text-zinc-400">Crea uno con el +</p>}
      {projects.length === 0 && <a href={routeHref({ view: 'projects' })} className="px-2 text-xs text-zinc-400 hover:underline">+ Crear proyecto</a>}

      <PeopleGroups route={route} />

      <MoreSection route={route} />

      <div className="mt-auto pt-4">
        <SyncBadge />
        <NavItem icon={Settings} href={routeHref({ view: 'settings' })} active={is('settings')}>Copias y ajustes</NavItem>
      </div>
    </nav>
  );
}

/** Quién ha entrado y si los cambios están guardados en el servidor. */
function SyncBadge() {
  const { user, status } = useSync();
  if (!user) return null;
  const label = { ok: 'Guardado', saving: 'Guardando…', offline: 'Sin conexión: los cambios esperan' }[status];
  const dot = { ok: 'bg-emerald-500', saving: 'bg-amber-400', offline: 'bg-red-500' }[status];
  return (
    <div className="mb-1 flex items-center gap-2 px-2 py-1 text-xs text-zinc-500" title={label}>
      <Avatar name={user.name} size={18} />
      <span className="min-w-0 flex-1 truncate">{user.name}</span>
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      <span className={status === 'offline' ? 'text-red-600 dark:text-red-400' : ''}>{status === 'offline' ? 'Sin conexión' : label}</span>
    </div>
  );
}

/** Grupos de personas: cada uno plegable con sus personas; "+" crea un grupo y se arrastra a la gente entre ellos. */
function PeopleGroups({ route }: { route: Route }) {
  const { tasks, notes, peopleCards, settings } = useApp();
  // Todas las personas: con tareas, mencionadas en notas, con ficha u Owners en Rally de lo que llevo.
  const rallyOwners = useRallyOwners(tasks);
  const people = peopleDirectory(tasks, notes, peopleCards, rallyOwners);
  const sections = groupPeople(people, peopleCards, settings.groups);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  async function create(e: FormEvent) {
    e.preventDefault();
    await createGroup(name, settings.groups);
    setName('');
    setAdding(false);
  }
  return (
    <>
      <Heading href={routeHref({ view: 'people' })} action={
        <button type="button" onClick={() => setAdding(true)} title="Nuevo grupo" className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700">
          <Plus className="size-3.5" />
        </button>
      }><Users className="mr-1.5 inline size-3.5" />Grupos</Heading>
      {adding && (
        <form onSubmit={create} className="mb-1 px-1">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (!name.trim()) setAdding(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setName(''); setAdding(false); } }} placeholder="Nombre del grupo"
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
        </form>
      )}
      {sections.map((s) => <GroupNav key={s.group?.id ?? 'none'} group={s.group} people={s.people} route={route} single={sections.length === 1 && !s.group} />)}
      {!settings.groups.length && !adding && (
        <button type="button" onClick={() => setAdding(true)} className="px-2 py-1 text-left text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">+ Crear un grupo</button>
      )}
    </>
  );
}

function GroupNav({ group, people, route, single }: { group: PersonGroup | null; people: PersonEntry[]; route: Route; single: boolean }) {
  const [open, setOpen] = usePersistentState<boolean>(`sidebar-group:${group?.id ?? 'none'}`, true);
  const [showAll, setShowAll] = useState(false);
  const { over, dropProps } = usePersonDrop((name) => void movePersonToGroup(name, group));
  const shown = showAll ? people : people.slice(0, 10);
  const isOpen = open || single;
  return (
    <div {...dropProps} className={over ? dropHighlight : ''}>
      {!single && (
        <button type="button" onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60">
          {open ? <ChevronDown className="size-3 text-zinc-400" /> : <ChevronRight className="size-3 text-zinc-400" />}
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: group?.color ?? '#a1a1aa' }} />
          <span className={`flex-1 truncate text-left ${group ? 'font-medium' : 'text-zinc-400'}`}>{group?.name ?? 'Sin grupo'}</span>
          <span className="text-xs text-zinc-400">{people.length || ''}</span>
        </button>
      )}
      {isOpen && shown.map((p) => (
        <div key={p.name} draggable onDragStart={(e) => setDraggedPerson(e, p.name)}>
          <NavItem href={routeHref({ view: 'person', name: p.name })} active={route.view === 'person' && route.name === p.name} count={p.tasks + p.rally}
            indent={single ? 0 : 1} lead={<Avatar name={p.name} size={18} />}>
            {p.name}
          </NavItem>
        </div>
      ))}
      {isOpen && people.length > 10 && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="px-2 py-0.5 pl-6 text-left text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
          {showAll ? 'Ver menos' : `Ver las ${people.length}`}
        </button>
      )}
      {isOpen && group && !people.length && <p className="py-0.5 pl-8 text-xs text-zinc-400">Arrastra personas aquí</p>}
    </div>
  );
}
