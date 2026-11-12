import { navigate, openSearch, type Route } from '../../app/router';
import { downloadBackup } from '../../data/backup';
import { repo } from '../../data/services';
import { addDays } from '../../domain/dates';
import { overdueTasks, peopleIndex } from '../../domain/selectors';
import type { ISODate, Project, Settings, Task } from '../../domain/types';
import { staleTasks } from '../../domain/maintenance';
import { TOPIC_TYPE_ID } from '../../domain/types';
import { newNote } from '../notes/NotesView';

export interface Command {
  id: string;
  title: string;
  section: string;
  /** Palabras extra para la búsqueda difusa. */
  keywords?: string;
  shortcut?: string;
  /** Si existe, el comando pide un texto antes de ejecutarse. */
  input?: { placeholder: string; run: (value: string) => void | Promise<void> };
  run?: () => void | Promise<void>;
}

export interface CommandEnv {
  tasks: Task[];
  projects: Project[];
  today: ISODate;
  settings: Settings;
  openCapture: () => void;
  openDistribute: () => void;
  openShortcuts: () => void;
  /** Tareas seleccionadas (o la enfocada). */
  selection: Task[];
  selectAll: () => void;
  toast: (message: string, action?: { label: string; run: () => void | Promise<void> }) => void;
}

/** Cambia la fecha de varias tareas como una sola entrada del historial. */
async function moveTasks(env: CommandEnv, tasks: Task[], to: ISODate | null, label: string) {
  if (tasks.length === 0) return env.toast('No hay tareas atrasadas');
  await repo.batch(`${tasks.length} ${tasks.length === 1 ? 'tarea movida' : 'tareas movidas'} a ${label}`, async () => {
    for (const t of tasks) await repo.updateTask(t.id, { due_date: to });
  });
}

const go = (r: Route) => () => navigate(r);

async function onSelection(env: CommandEnv, label: string, fn: (t: Task) => Promise<unknown>) {
  if (!env.selection.length) return env.toast('No hay tareas seleccionadas');
  const n = env.selection.length;
  await repo.batch(n === 1 ? `Tarea: ${label}` : `${n} tareas: ${label}`, async () => {
    for (const t of env.selection) await fn(t);
  });
}

export function buildCommands(env: CommandEnv): Command[] {
  const overdue = overdueTasks(env.tasks, env.today);
  const sel = env.selection.length ? ` (${env.selection.length})` : '';
  return [
    { id: 'new-task', section: 'Crear', title: 'Nueva tarea', shortcut: '⌘K', keywords: 'añadir capturar', run: env.openCapture },
    {
      id: 'new-project', section: 'Crear', title: 'Nuevo proyecto', keywords: 'crear',
      input: {
        placeholder: 'Nombre del proyecto',
        run: async (name) => {
          if (!name.trim()) return;
          const p = await repo.createProject(name);
          navigate({ view: 'project', id: p.id });
        },
      },
    },
    { id: 'move-overdue-today', section: 'Tareas', title: 'Mover vencidas a hoy', keywords: 'atrasadas', run: () => moveTasks(env, overdue, env.today, 'hoy') },
    { id: 'move-overdue-tomorrow', section: 'Tareas', title: 'Mover vencidas a mañana', keywords: 'atrasadas', run: () => moveTasks(env, overdue, addDays(env.today, 1), 'mañana') },
    { id: 'distribute', section: 'Tareas', title: 'Repartir atrasadas', keywords: 'vencidas distribuir capacidad', run: env.openDistribute },
    {
      id: 'archive-stale', section: 'Tareas', title: 'Archivar tareas sin tocar (+30 días)', keywords: 'obsoletas viejas',
      run: async () => {
        const stale = staleTasks(env.tasks, env.today);
        if (!stale.length) return env.toast('No hay tareas sin tocar desde hace más de 30 días');
        await repo.batch(`${stale.length} tareas archivadas`, async () => {
          for (const t of stale) await repo.updateTask(t.id, { status: 'archived' });
        });
      },
    },
    {
      id: 'summary', section: 'Ayuda', title: 'Ver resumen del día', keywords: 'hoy importante',
      run: async () => {
        await repo.updateSettings({ ui: { ...env.settings.ui, summary_dismissed_on: null } });
        navigate({ view: 'today' });
      },
    },
    { id: 'move-overdue-none', section: 'Tareas', title: 'Quitar fecha a las vencidas', keywords: 'atrasadas sin fecha', run: () => moveTasks(env, overdue, null, 'sin fecha') },

    { id: 'sel-complete', section: 'Selección', title: `Completar seleccionadas${sel}`, shortcut: 'C', run: () => onSelection(env, 'completada', (t) => repo.setCompleted(t.id, true)) },
    { id: 'sel-today', section: 'Selección', title: `Mover seleccionadas a hoy${sel}`, shortcut: 'T', run: () => onSelection(env, 'a hoy', (t) => repo.updateTask(t.id, { due_date: env.today })) },
    { id: 'sel-tomorrow', section: 'Selección', title: `Mover seleccionadas a mañana${sel}`, shortcut: '⇧T', run: () => onSelection(env, 'a mañana', (t) => repo.updateTask(t.id, { due_date: addDays(env.today, 1) })) },
    { id: 'sel-nodate', section: 'Selección', title: `Quitar fecha a las seleccionadas${sel}`, run: () => onSelection(env, 'sin fecha', (t) => repo.updateTask(t.id, { due_date: null })) },
    { id: 'sel-delete', section: 'Selección', title: `Eliminar seleccionadas${sel}`, shortcut: 'Supr', keywords: 'borrar', run: () => onSelection(env, 'eliminada', (t) => repo.deleteTask(t.id)) },
    { id: 'sel-all', section: 'Selección', title: 'Seleccionar todas las visibles', shortcut: '⌘A', run: env.selectAll },
    { id: 'undo', section: 'Editar', title: 'Deshacer', shortcut: '⌘Z', run: () => void repo.undo() },
    { id: 'redo', section: 'Editar', title: 'Rehacer', shortcut: '⌘⇧Z', run: () => void repo.redo() },
    { id: 'search', section: 'Ir a', title: 'Buscar tareas', shortcut: '/', keywords: 'encontrar filtrar', run: () => openSearch() },
    { id: 'go-today', section: 'Ir a', title: 'Ir a Hoy', shortcut: 'G H', run: go({ view: 'today' }) },
    { id: 'go-week', section: 'Ir a', title: 'Ir a Calendario: semana', shortcut: 'G S', keywords: 'semana', run: go({ view: 'week' }) },
    { id: 'go-board', section: 'Ir a', title: 'Ir a Tablero', shortcut: 'G T', keywords: 'kanban trello columnas todo filtros us ts temas vista lista', run: go({ view: 'board' }) },
    { id: 'go-notes', section: 'Ir a', title: 'Ir a Notas', shortcut: 'G N', keywords: 'actas reuniones apuntes', run: go({ view: 'notes' }) },
    { id: 'new-meeting', section: 'Crear', title: 'Nueva acta de reunión', keywords: 'nota reunión daily', run: () => newNote('meeting', env.today).then(() => undefined) },
    { id: 'new-note', section: 'Crear', title: 'Nueva nota', keywords: 'apunte', run: () => newNote('note', env.today).then(() => undefined) },
    {
      id: 'new-topic', section: 'Crear', title: 'Para hablar con… (nuevo)', keywords: 'pendiente persona conversación',
      input: {
        placeholder: '@persona qué tienes que hablar',
        run: async (text) => {
          const m = /@([\p{L}\p{N}_\-.]+)/u.exec(text);
          if (!m) return env.toast('Escribe @persona y lo que quieres hablar');
          const name = m[1].replace(/-/g, ' ');
          const title = text.replace(m[0], '').trim();
          if (!title) return;
          await repo.batch('Añadido a Para hablar', () => repo.createTask({ title, type_id: TOPIC_TYPE_ID, people: [name] }));
        },
      },
    },
    { id: 'go-review', section: 'Ir a', title: 'Revisión semanal', shortcut: 'G V', keywords: 'repaso semana planificar gtd', run: go({ view: 'review' }) },
    { id: 'go-log', section: 'Ir a', title: 'Ir a Registro', shortcut: 'G L', keywords: 'hecho pospuesto diario historial semana', run: go({ view: 'log' }) },
    { id: 'go-calendar', section: 'Ir a', title: 'Ir a Calendario: mes', shortcut: 'G C', keywords: 'mes fechas', run: go({ view: 'calendar' }) },
    { id: 'go-inbox', section: 'Ir a', title: 'Ir a Bandeja', shortcut: 'G B', keywords: 'entrada', run: go({ view: 'inbox' }) },
    { id: 'go-people', section: 'Ir a', title: 'Ir a Grupos (personas)', shortcut: 'G E', run: go({ view: 'people' }) },
    { id: 'go-settings', section: 'Ir a', title: 'Ir a Copias y ajustes', shortcut: 'G A', keywords: 'backup configuración', run: go({ view: 'settings' }) },
    ...env.projects.map((p): Command => ({
      id: `go-project-${p.id}`, section: 'Proyectos', title: `Ir a proyecto ${p.name}`, keywords: '#', run: go({ view: 'project', id: p.id }),
    })),
    ...peopleIndex(env.tasks).map(({ name }): Command => ({
      id: `go-person-${name}`, section: 'Personas', title: `Ir a persona @${name}`, run: go({ view: 'person', name }),
    })),

    { id: 'export', section: 'Datos', title: 'Exportar copia', keywords: 'backup json descargar guardar', run: () => downloadBackup(repo) },
    { id: 'shortcuts', section: 'Ayuda', title: 'Atajos de teclado', shortcut: '?', keywords: 'ayuda chuleta', run: env.openShortcuts },
  ];
}
