import {
  type ActivityEntry,
  DEFAULT_SETTINGS,
  DEFAULT_TYPE_ID,
  PROJECT_COLORS,
  type ItemType,
  type Label,
  type NewTask,
  type Note,
  type Person,
  type Project,
  type Release,
  type Settings,
  type Task,
  type TaskPatch,
} from '../domain/types';
import { isRallyId } from '../domain/rally';
import { doneState, equivalentState, findType, initialState, isDoneCategory, missingRallyTypes, patchForState, rallyPrefix, stateOf, typeForPrefix, withAcceptedState } from '../domain/workflows';
import { nameKey } from '../domain/text';
import { withDescendants } from '../domain/projects';
import { extractMentions } from '../domain/markdown';
import { activityFor } from '../domain/activity';
import { dropMentions, renameInList, renameMentions } from '../domain/people';
import { BACKUP_APP_ID, settingsSchema, type Backup } from '../domain/schemas';
import type { Table } from 'dexie';
import { formatDay, todayISO } from '../domain/dates';
import { nextOccurrenceTask } from '../domain/maintenance';
import { SCHEMA_VERSION, TasksDB } from './db';

type TableName = 'tasks' | 'projects' | 'labels' | 'item_types' | 'releases' | 'notes' | 'people' | 'activity';
type Row = Task | Project | Label | ItemType | Release | Note | Person | ActivityEntry;

/** Estado de un registro antes y después de un cambio (undefined = no existía). */
export interface Change {
  table: TableName;
  key: string;
  before: Row | undefined;
  after: Row | undefined;
}

export interface HistoryEntry {
  label: string;
  changes: Change[];
  /** Se puede deshacer pero no muestra aviso (p. ej. el autoguardado de una nota). */
  silent?: boolean;
}

export type HistoryEvent = { type: 'push' | 'undo' | 'redo'; entry: HistoryEntry };

/**
 * Único punto de acceso a los datos. Los componentes no tocan Dexie directamente,
 * así se puede sustituir IndexedDB por un backend remoto implementando esta interfaz.
 */
export interface Repository {
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(input: NewTask, opts?: { spaceDefault?: boolean }): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task | undefined>;
  setCompleted(id: string, done: boolean): Promise<void>;
  /** Mueve la tarea a un estado de su flujo (y la completa o reabre según la categoría). */
  setState(id: string, stateId: string): Promise<void>;
  /** Cambia el tipo (Tarea, US, TS…) manteniendo un estado equivalente. */
  setType(id: string, typeId: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  restoreTask(id: string): Promise<void>;
  purgeDeleted(olderThanDays: number): Promise<number>;

  listProjects(includeArchived?: boolean): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  createProject(name: string, opts?: { color?: string; parent_id?: string | null; space_id?: string | null }): Promise<Project>;
  updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<void>;

  listItemTypes(): Promise<ItemType[]>;
  createItemType(name: string): Promise<ItemType>;
  /** Guarda un tipo; las tareas en estados eliminados pasan al estado equivalente por categoría. */
  saveItemType(type: ItemType): Promise<void>;
  /**
   * Añade el estado "Accepted" a Tarea, User Story y Test Scenario si no lo tienen. Sin historial ni aviso: es una
   * actualización de los tipos comunes, así que solo la lanza un administrador (se sincroniza al resto del equipo).
   */
  ensureAcceptedStates(): Promise<void>;
  /**
   * Tipos de Rally (Feature, Defect, Defect Suite, Task…): con `addTypes` (administradora) añade los que falten y, para
   * cualquiera, pasa a su tipo las tareas que siguen como Tarea con un ID de Rally de ese prefijo. Sin historial.
   */
  ensureRallyTypes(addTypes: boolean): Promise<void>;
  /** Elimina un tipo (no el de Tarea); sus tareas pasan a Tarea. */
  deleteItemType(id: string): Promise<void>;

  listReleases(): Promise<Release[]>;
  createRelease(name: string, fields?: Partial<Omit<Release, 'id' | 'name' | 'created_at'>>): Promise<Release>;
  updateRelease(id: string, patch: Partial<Omit<Release, 'id'>>): Promise<void>;
  /** Elimina la release y la quita de sus tareas. */
  deleteRelease(id: string): Promise<void>;
  deleteProject(id: string): Promise<{ tasks: number; notes: number }>;

  listLabels(): Promise<Label[]>;
  setLabelColor(name: string, color: string): Promise<void>;
  renameLabel(from: string, to: string): Promise<void>;
  /** Quita la etiqueta de todas las tareas y su color. */
  deleteLabel(name: string): Promise<void>;

  listNotes(): Promise<Note[]>;
  getNote(id: string): Promise<Note | undefined>;
  createNote(fields: Partial<Omit<Note, 'id' | 'created_at' | 'updated_at'>> & Pick<Note, 'date'>): Promise<Note>;
  /** Actualiza una nota (recalcula las personas mencionadas si cambia el cuerpo). */
  updateNote(id: string, patch: Partial<Omit<Note, 'id' | 'created_at'>>, opts?: { silent?: boolean }): Promise<void>;
  deleteNote(id: string): Promise<void>;

  /** Registro de actividad (todo, o desde una fecha). */
  listActivity(fromDate?: string): Promise<ActivityEntry[]>;

  listPeople(): Promise<Person[]>;
  savePerson(person: Person): Promise<void>;
  /**
   * Renombra a una persona en tareas, menciones de notas y ficha. Si ya existe otra con el nombre
   * nuevo, las une (la ficha resultante conserva los datos de las dos).
   */
  renamePerson(from: string, to: string): Promise<string>;
  deletePerson(name: string): Promise<number>;
  setPersonGroup(name: string, groupId: string | null): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Registra una copia hecha. No dispara onChange para no provocar otra copia automática. */
  markBackup(at?: Date): Promise<void>;

  exportSnapshot(): Promise<Backup>;
  replaceAll(backup: Backup): Promise<void>;
  /**
   * Añade el contenido de una copia sin borrar nada (un solo "Deshacer"). Reutiliza lo que ya existe:
   * proyectos por nombre dentro del mismo padre, personas por nombre, tareas por ID externo (o título y
   * proyecto) y notas por título, proyecto y elemento.
   */
  mergeBackup(backup: Backup): Promise<MergeResult>;

  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;

  /** Agrupa varias mutaciones en una sola entrada del historial (un solo "Deshacer"). */
  batch<T>(label: string, fn: () => Promise<T>, opts?: { silent?: boolean }): Promise<T>;
  undo(): Promise<HistoryEntry | null>;
  redo(): Promise<HistoryEntry | null>;
  onHistory(listener: (e: HistoryEvent) => void): () => void;

  /** Se llama tras cada cambio en los datos que deben respaldarse. */
  onChange(listener: () => void): () => void;
}

export interface MergeResult { projects: number; tasks: number; notes: number; people: number; skipped: number }

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const SETTINGS_KEY = 'settings';
const HISTORY_LIMIT = 100;

export class DexieRepository implements Repository {
  private listeners = new Set<() => void>();
  private historyListeners = new Set<(e: HistoryEvent) => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private group: HistoryEntry | null = null;
  readonly db: TasksDB;
  /** Espacio para los proyectos nuevos sin espacio indicado (el del filtro de la barra lateral). */
  defaultSpaceId: string | null = null;
  /** Nombre y color del espacio del filtro: una tarea sin proyecto creada con él va a su proyecto de espacio. */
  defaultSpace: { id: string; name: string; color: string } | null = null;

  constructor(db: TasksDB = new TasksDB()) {
    this.db = db;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // ---------- Historial (deshacer / rehacer) ----------

  onHistory(listener: (e: HistoryEvent) => void) {
    this.historyListeners.add(listener);
    return () => void this.historyListeners.delete(listener);
  }

  private notify(e: HistoryEvent) {
    for (const l of this.historyListeners) l(e);
  }

  private record(change: Change, defaultLabel: string) {
    this.recordMany([change], defaultLabel);
  }

  /** Varios cambios en una sola entrada (p. ej. una tarea y sus apuntes del registro). */
  private recordMany(changes: Change[], defaultLabel: string) {
    if (this.group) {
      this.group.changes.push(...changes);
      return;
    }
    this.push({ label: defaultLabel, changes });
  }

  /** Escribe los apuntes del registro que genera un cambio de tarea y devuelve sus cambios para el historial. */
  private async logActivity(before: Task | undefined, after: Task | undefined): Promise<Change[]> {
    if (!after) return [];
    const at = now();
    const date = todayISO();
    const entries: ActivityEntry[] = activityFor(before, after).map((e) => ({
      id: uuid(), at, date, kind: e.kind, task_id: after.id, title: after.title, project_id: after.project_id, from: e.from, to: e.to,
    }));
    if (entries.length) await this.db.activity.bulkAdd(entries);
    return entries.map((e) => ({ table: 'activity' as const, key: e.id, before: undefined, after: e }));
  }

  private push(entry: HistoryEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.notify({ type: 'push', entry });
  }

  async batch<T>(label: string, fn: () => Promise<T>, opts: { silent?: boolean } = {}): Promise<T> {
    if (this.group) return fn(); // anidado: se suma al grupo exterior
    const group: HistoryEntry = { label, changes: [], ...(opts.silent ? { silent: true } : {}) };
    this.group = group;
    try {
      return await fn();
    } finally {
      this.group = null;
      if (group.changes.length) this.push(group);
    }
  }

  private async apply(entry: HistoryEntry, side: 'before' | 'after') {
    const changes = side === 'before' ? [...entry.changes].reverse() : entry.changes;
    await this.db.transaction('rw', [this.db.tasks, this.db.projects, this.db.labels, this.db.item_types, this.db.releases, this.db.notes, this.db.people, this.db.activity], async () => {
      for (const c of changes) {
        const table = this.db[c.table] as unknown as Table<Row, string>;
        const value = c[side];
        if (value === undefined) await table.delete(c.key);
        else await table.put(value);
      }
    });
    this.emit();
  }

  async undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    await this.apply(entry, 'before');
    this.redoStack.push(entry);
    this.notify({ type: 'undo', entry });
    return entry;
  }

  async redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    await this.apply(entry, 'after');
    this.undoStack.push(entry);
    this.notify({ type: 'redo', entry });
    return entry;
  }

  // ---------- Tareas ----------

  async listTasks() {
    return (await this.db.tasks.toArray()).filter((t) => !t.deleted_at);
  }

  getTask(id: string) {
    return this.db.tasks.get(id);
  }

  async createTask(input: NewTask, opts: { spaceDefault?: boolean } = {}): Promise<Task> {
    // Con un espacio elegido en el filtro, una tarea sin proyecto no puede quedarse privada (desaparecería de la vista):
    // va al proyecto con el nombre del espacio, que se crea si no existe. Un solo "Deshacer" quita las dos cosas.
    const space = opts.spaceDefault === false ? null : this.defaultSpace;
    if (space && !input.project_id) {
      return this.batch('Tarea creada', async () => {
        const project_id = await this.spaceProject(space);
        return this.createTask({ ...input, project_id }, { spaceDefault: false });
      });
    }
    const ts = now();
    const type = findType(await this.listItemTypes(), input.type_id ?? DEFAULT_TYPE_ID);
    const state = input.state_id ? stateOf([type], { type_id: type.id, state_id: input.state_id, status: 'todo' })
      : input.status === 'done' ? doneState(type) : initialState(type);
    const task: Task = {
      project_id: null,
      notes: '',
      due_date: null,
      priority: 4,
      estimated_minutes: null,
      people: [],
      tags: [],
      status: 'todo',
      recurrence_rule: null,
      series_id: null,
      sort_order: Date.now(),
      raw_input: input.title,
      completed_at: null,
      deleted_at: null,
      checklist: [],
      external_id: null,
      url: null,
      release_id: null,
      remind_at: null,
      my_day: null,
      board_column: null,
      ...input,
      type_id: type.id,
      state_id: state.id,
      ...(isDoneCategory(state.category) ? { status: 'done' as const, completed_at: input.completed_at ?? ts } : {}),
      title: input.title.trim(),
      id: uuid(),
      created_at: ts,
      updated_at: ts,
      last_touched_at: ts,
    };
    await this.db.tasks.add(task);
    const log = await this.logActivity(undefined, task);
    this.recordMany([{ table: 'tasks', key: task.id, before: undefined, after: task }, ...log], 'Tarea creada');
    this.emit();
    return task;
  }

  /** Actualiza una tarea y registra el cambio. `touch` = cuenta como "tocada" (por defecto sí). */
  private async patchTask(id: string, patch: TaskPatch, label: string, touch = true) {
    const before = await this.db.tasks.get(id);
    if (!before) return undefined;
    const ts = now();
    await this.db.tasks.update(id, touch ? { ...patch, updated_at: ts, last_touched_at: ts } : patch);
    const after = await this.db.tasks.get(id);
    const log = await this.logActivity(before, after);
    this.recordMany([{ table: 'tasks', key: id, before, after }, ...log], label);
    this.emit();
    return after;
  }

  updateTask(id: string, patch: TaskPatch) {
    return this.patchTask(id, patch, 'Tarea actualizada');
  }

  /** Completar una recurrente crea su siguiente ocurrencia (misma entrada del historial). */
  async setCompleted(id: string, done: boolean) {
    const task = await this.db.tasks.get(id);
    if (!task) return;
    const today = todayISO();
    let next = done && task.status !== 'done' ? nextOccurrenceTask(task, today) : null;
    // Si la serie ya tiene una ocurrencia pendiente (p. ej. se desmarcó y se vuelve a completar), no se duplica.
    if (next?.series_id) {
      const pending = await this.db.tasks.where('series_id').equals(next.series_id)
        .filter((t) => t.id !== id && t.status === 'todo' && !t.deleted_at).count();
      if (pending) next = null;
    }
    const label = !done ? 'Tarea marcada como pendiente'
      : next ? `Tarea completada · se repite ${formatDay(next.due_date!, today).toLowerCase()}` : 'Tarea completada';
    await this.batch(label, async () => {
      const type = findType(await this.listItemTypes(), task.type_id);
      await this.patchTask(id, done
        ? { status: 'done', completed_at: now(), state_id: doneState(type).id }
        : { status: 'todo', completed_at: null, state_id: initialState(type).id }, label);
      if (next) await this.createTask(next, { spaceDefault: false });
    });
  }

  async setState(id: string, stateId: string) {
    const task = await this.db.tasks.get(id);
    if (!task || task.state_id === stateId) return;
    const types = await this.listItemTypes();
    const type = findType(types, task.type_id);
    const state = type.states.find((s) => s.id === stateId);
    if (!state) return;
    // Pasar a "hecho" es completar: así las recurrentes generan su siguiente ocurrencia.
    if (isDoneCategory(state.category) && task.status !== 'done') {
      await this.batch(`${state.name}`, async () => {
        await this.setCompleted(id, true);
        await this.patchTask(id, { state_id: state.id }, state.name);
      });
      return;
    }
    await this.patchTask(id, patchForState(task, state, now()), `Movida a ${state.name}`);
  }

  async setType(id: string, typeId: string) {
    const task = await this.db.tasks.get(id);
    if (!task || task.type_id === typeId) return;
    const types = await this.listItemTypes();
    const to = findType(types, typeId);
    const state = equivalentState(stateOf(types, task), to);
    await this.patchTask(id, { type_id: to.id, state_id: state.id }, `Ahora es ${to.name}`);
  }

  async deleteTask(id: string) {
    await this.patchTask(id, { deleted_at: now() }, 'Tarea eliminada', false);
  }

  async restoreTask(id: string) {
    await this.patchTask(id, { deleted_at: null }, 'Tarea restaurada', false);
  }

  /** Borrado definitivo de lo eliminado hace tiempo. No pasa por el historial. */
  async purgeDeleted(olderThanDays: number) {
    const limit = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const n = await this.db.tasks.where('deleted_at').below(limit).delete();
    if (n) this.emit();
    return n;
  }

  // ---------- Proyectos ----------

  async listProjects(includeArchived = false) {
    const all = await this.db.projects.toArray();
    return all
      .filter((p) => includeArchived || !p.archived)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  getProject(id: string) {
    return this.db.projects.get(id);
  }

  /** Proyecto de nivel superior con el nombre del espacio (el sitio de lo que no tiene otro proyecto). */
  private async spaceProject(space: { id: string; name: string; color: string }) {
    const found = (await this.db.projects.toArray())
      .find((p) => !p.archived && !p.parent_id && p.space_id === space.id && nameKey(p.name) === nameKey(space.name));
    return (found ?? await this.createProject(space.name, { color: space.color, space_id: space.id })).id;
  }

  async createProject(name: string, opts: { color?: string; parent_id?: string | null; space_id?: string | null } = {}) {
    const count = await this.db.projects.count();
    const project: Project = {
      id: uuid(),
      name: name.trim(),
      // Un subproyecto hereda el color de su padre (se puede cambiar).
      color: opts.color ?? (opts.parent_id ? (await this.db.projects.get(opts.parent_id))?.color : undefined) ?? PROJECT_COLORS[count % PROJECT_COLORS.length],
      archived: false,
      created_at: now(),
      parent_id: opts.parent_id ?? null,
      // Un subproyecto no lleva espacio propio: hereda el del padre.
      space_id: opts.parent_id ? null : opts.space_id === undefined ? this.defaultSpaceId : opts.space_id,
    };
    await this.db.projects.add(project);
    this.record({ table: 'projects', key: project.id, before: undefined, after: project }, 'Proyecto creado');
    this.emit();
    return project;
  }

  async updateProject(id: string, patch: Partial<Omit<Project, 'id'>>) {
    const before = await this.db.projects.get(id);
    if (!before) return;
    await this.db.projects.update(id, patch);
    const after = await this.db.projects.get(id);
    this.record({ table: 'projects', key: id, before, after }, 'Proyecto actualizado');
    this.emit();
  }

  /**
   * Elimina un proyecto con sus subproyectos. Sus tareas pasan a eliminadas (se pueden restaurar desde el Registro hasta que
   * se purguen) y sus notas se quedan sin sección. Todo en un solo «Deshacer».
   */
  async deleteProject(id: string) {
    const all = await this.db.projects.toArray();
    const root = all.find((p) => p.id === id);
    if (!root) return { tasks: 0, notes: 0 };
    const ids = withDescendants(id, all);
    let tasks = 0;
    let notes = 0;
    await this.batch(`Proyecto ${root.name} eliminado`, async () => {
      for (const t of await this.db.tasks.toArray()) {
        if (t.project_id && ids.has(t.project_id) && !t.deleted_at) { await this.patchTask(t.id, { deleted_at: now() }, '', false); tasks++; }
      }
      for (const n of await this.db.notes.toArray()) {
        if (n.project_id && ids.has(n.project_id)) { await this.updateNote(n.id, { project_id: null }); notes++; }
      }
      for (const pid of ids) {
        const before = await this.db.projects.get(pid);
        if (!before) continue;
        await this.db.projects.delete(pid);
        this.record({ table: 'projects', key: pid, before, after: undefined }, '');
      }
    });
    return { tasks, notes };
  }

  // ---------- Tipos de elemento ----------

  async listItemTypes() {
    return (await this.db.item_types.toArray()).sort((a, b) => a.order - b.order);
  }

  async createItemType(name: string) {
    const types = await this.listItemTypes();
    const id = uuid();
    const short = name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
    const type: ItemType = {
      id, name: name.trim(), short, color: PROJECT_COLORS[types.length % PROJECT_COLORS.length], order: types.length,
      states: [
        { id: `${id}-todo`, name: 'Por hacer', color: '#94a3b8', category: 'todo' },
        { id: `${id}-doing`, name: 'En curso', color: '#3b82f6', category: 'doing' },
        { id: `${id}-blocked`, name: 'Bloqueado', color: '#ef4444', category: 'blocked' },
        { id: `${id}-done`, name: 'Hecho', color: '#22c55e', category: 'done' },
      ],
    };
    await this.db.item_types.add(type);
    this.record({ table: 'item_types', key: id, before: undefined, after: type }, `Tipo ${type.name} creado`);
    this.emit();
    return type;
  }

  async ensureAcceptedStates() {
    for (const type of await this.listItemTypes()) {
      const next = withAcceptedState(type);
      if (next) await this.db.item_types.put(next);
    }
  }

  async ensureRallyTypes(addTypes: boolean) {
    let types = await this.listItemTypes();
    if (addTypes) {
      const order = Math.max(0, ...types.map((t) => t.order)) + 1;
      const missing = missingRallyTypes(types).map((t, i) => ({ ...t, order: order + i }));
      if (missing.length) {
        await this.db.item_types.bulkPut(missing);
        types = await this.listItemTypes();
      }
    }
    const tasks = (await this.db.tasks.where('type_id').equals(DEFAULT_TYPE_ID).toArray())
      .filter((t) => !t.deleted_at && t.external_id && isRallyId(t.external_id));
    for (const t of tasks) {
      const prefix = rallyPrefix(t.external_id!);
      const to = prefix ? typeForPrefix(types, prefix) : undefined;
      if (!to || to.id === DEFAULT_TYPE_ID) continue;
      await this.db.tasks.update(t.id, { type_id: to.id, state_id: equivalentState(stateOf(types, t), to).id });
    }
  }

  async saveItemType(type: ItemType) {
    const before = await this.db.item_types.get(type.id);
    if (!type.states.length) return;
    await this.batch(`Tipo ${type.name} guardado`, async () => {
      await this.db.item_types.put(type);
      this.record({ table: 'item_types', key: type.id, before, after: type }, '');
      // Tareas en estados que ya no existen: al equivalente por categoría.
      const ids = new Set(type.states.map((st) => st.id));
      const orphans = (await this.db.tasks.where('type_id').equals(type.id).toArray()).filter((t) => !ids.has(t.state_id));
      for (const t of orphans) {
        const old = before?.states.find((st) => st.id === t.state_id);
        const state = old ? equivalentState(old, type) : t.status === 'done' ? doneState(type) : initialState(type);
        await this.patchTask(t.id, patchForState(t, state, now()), '', false);
      }
    });
  }

  async deleteItemType(id: string) {
    if (id === DEFAULT_TYPE_ID) return;
    const types = await this.listItemTypes();
    const type = types.find((t) => t.id === id);
    if (!type) return;
    const fallback = findType(types, DEFAULT_TYPE_ID);
    await this.batch(`Tipo ${type.name} eliminado`, async () => {
      for (const t of await this.db.tasks.where('type_id').equals(id).toArray()) {
        const state = equivalentState(stateOf(types, t), fallback);
        await this.patchTask(t.id, { type_id: fallback.id, state_id: state.id }, '', false);
      }
      await this.db.item_types.delete(id);
      this.record({ table: 'item_types', key: id, before: type, after: undefined }, '');
    });
  }

  // ---------- Releases ----------

  async listReleases() {
    return (await this.db.releases.toArray()).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.name.localeCompare(b.name, 'es'));
  }

  async createRelease(name: string, fields: Partial<Omit<Release, 'id' | 'name' | 'created_at'>> = {}) {
    const release: Release = { date: null, project_id: null, status: 'planned', notes: '', ...fields, id: uuid(), name: name.trim(), created_at: now() };
    await this.db.releases.add(release);
    this.record({ table: 'releases', key: release.id, before: undefined, after: release }, `Release ${release.name} creada`);
    this.emit();
    return release;
  }

  async updateRelease(id: string, patch: Partial<Omit<Release, 'id'>>) {
    const before = await this.db.releases.get(id);
    if (!before) return;
    await this.db.releases.update(id, patch);
    const after = await this.db.releases.get(id);
    this.record({ table: 'releases', key: id, before, after }, 'Release actualizada');
    this.emit();
  }

  async deleteRelease(id: string) {
    const release = await this.db.releases.get(id);
    if (!release) return;
    await this.batch(`Release ${release.name} eliminada`, async () => {
      for (const t of await this.db.tasks.where('release_id').equals(id).toArray()) {
        await this.patchTask(t.id, { release_id: null }, '', false);
      }
      await this.db.releases.delete(id);
      this.record({ table: 'releases', key: id, before: release, after: undefined }, '');
    });
  }

  // ---------- Notas ----------

  async listNotes() {
    return (await this.db.notes.toArray()).filter((n) => !n.deleted_at);
  }

  getNote(id: string) {
    return this.db.notes.get(id);
  }

  async createNote(fields: Partial<Omit<Note, 'id' | 'created_at' | 'updated_at'>> & Pick<Note, 'date'>) {
    const ts = now();
    const body = fields.body ?? '';
    const note: Note = {
      title: '', kind: 'note', project_id: null, pinned: false, deleted_at: null, task_id: null, meeting_url: null, sort_order: Date.now(),
      ...fields, body, people: extractMentions(body), id: uuid(), created_at: ts, updated_at: ts,
    };
    await this.db.notes.add(note);
    this.record({ table: 'notes', key: note.id, before: undefined, after: note }, note.kind === 'meeting' ? 'Acta creada' : 'Nota creada');
    this.emit();
    return note;
  }

  async updateNote(id: string, patch: Partial<Omit<Note, 'id' | 'created_at'>>, opts: { silent?: boolean } = {}) {
    const before = await this.db.notes.get(id);
    if (!before) return;
    const full = { ...patch, updated_at: now(), ...(patch.body !== undefined ? { people: extractMentions(patch.body) } : {}) };
    const write = async () => {
      await this.db.notes.update(id, full);
      const after = await this.db.notes.get(id);
      this.record({ table: 'notes', key: id, before, after }, 'Nota actualizada');
    };
    if (opts.silent) await this.batch('Nota guardada', write, { silent: true });
    else await write();
    this.emit();
  }

  async deleteNote(id: string) {
    const n = await this.db.notes.get(id);
    if (!n) return;
    await this.batch(n.kind === 'meeting' ? 'Acta eliminada' : 'Nota eliminada', () => this.updateNote(id, { deleted_at: now() }));
  }

  // ---------- Registro ----------

  async listActivity(fromDate?: string) {
    return fromDate ? this.db.activity.where('date').aboveOrEqual(fromDate).toArray() : this.db.activity.toArray();
  }

  // ---------- Personas ----------

  async listPeople() {
    return this.db.people.toArray();
  }

  async savePerson(person: Person) {
    const before = (await this.db.people.toArray()).find((p) => nameKey(p.name) === nameKey(person.name));
    // Se conserva lo que no venga (p. ej. el grupo al editar el rol).
    const after: Person = { ...before, ...person, name: before?.name ?? person.name };
    await this.db.people.put(after);
    this.record({ table: 'people', key: after.name, before, after }, 'Ficha guardada');
    this.emit();
  }

  /** Mete a la persona en un grupo (null = sin grupo). Crea la ficha si no la tenía. */
  async setPersonGroup(name: string, groupId: string | null) {
    const card = (await this.db.people.toArray()).find((p) => nameKey(p.name) === nameKey(name));
    if ((card?.group_id ?? null) === groupId) return;
    await this.savePerson({ name, role: card?.role ?? '', notes: card?.notes ?? '', email: card?.email ?? '', group_id: groupId });
  }

  /** Renombra a una persona o la une con otra que ya existe. Devuelve el nombre con el que queda. */
  async renamePerson(from: string, to: string): Promise<string> {
    const typed = to.trim();
    if (!typed || nameKey(from) === nameKey(typed) && from === typed) return from;
    // Si la persona de destino ya existe (ficha o tareas), se usa su nombre tal cual, aunque se escriba con otras
    // mayúsculas o sin tildes: así no quedan dos «Diana» distintas.
    const cardsNow = await this.db.people.toArray();
    const sameKey = (n: string) => nameKey(n) === nameKey(typed) && nameKey(n) !== nameKey(from);
    const target = cardsNow.find((c) => sameKey(c.name))?.name
      ?? (await this.db.tasks.toArray()).flatMap((t) => t.people).find(sameKey)
      ?? typed;
    await this.batch(`${from} → ${target}`, async () => {
      for (const t of await this.db.tasks.toArray()) {
        if (!t.people.some((p) => nameKey(p) === nameKey(from))) continue;
        await this.patchTask(t.id, { people: renameInList(t.people, from, target) }, '', false);
      }
      for (const n of await this.db.notes.toArray()) {
        const body = renameMentions(n.body, from, target);
        if (body !== n.body) await this.updateNote(n.id, { body });
      }
      // Fichas: la del nombre nuevo manda; lo que le falte se toma de la antigua.
      const cards = await this.db.people.toArray();
      const old = cards.find((c) => nameKey(c.name) === nameKey(from));
      const dest = cards.find((c) => nameKey(c.name) === nameKey(target) && c !== old);
      if (old) {
        await this.db.people.delete(old.name);
        this.record({ table: 'people', key: old.name, before: old, after: undefined }, '');
      }
      if (old || dest) {
        const merged: Person = {
          name: dest?.name ?? target,
          role: dest?.role || old?.role || '',
          notes: [dest?.notes, old?.notes].filter(Boolean).join('\n'),
          email: dest?.email || old?.email || '',
          ...((dest?.group_id ?? old?.group_id) ? { group_id: dest?.group_id ?? old?.group_id } : {}),
        };
        await this.db.people.put(merged);
        this.record({ table: 'people', key: merged.name, before: dest, after: merged }, '');
      }
      this.emit();
    });
    return target;
  }

  /**
   * Elimina a una persona: sale de las tareas, sus menciones en notas pasan a texto normal y se borra su ficha. Las tareas
   * y notas se quedan. Todo en un solo «Deshacer».
   */
  async deletePerson(name: string) {
    let tasks = 0;
    await this.batch(`${name} eliminada`, async () => {
      for (const t of await this.db.tasks.toArray()) {
        if (!t.people.some((p) => nameKey(p) === nameKey(name))) continue;
        await this.patchTask(t.id, { people: t.people.filter((p) => nameKey(p) !== nameKey(name)) }, '', false);
        tasks++;
      }
      for (const n of await this.db.notes.toArray()) {
        const body = dropMentions(n.body, name);
        if (body !== n.body) await this.updateNote(n.id, { body });
      }
      for (const card of await this.db.people.toArray()) {
        if (nameKey(card.name) !== nameKey(name)) continue;
        await this.db.people.delete(card.name);
        this.record({ table: 'people', key: card.name, before: card, after: undefined }, '');
      }
      this.emit();
    });
    return tasks;
  }

  // ---------- Etiquetas ----------

  async listLabels() {
    return (await this.db.labels.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private async findLabel(name: string) {
    return (await this.db.labels.toArray()).find((l) => nameKey(l.name) === nameKey(name));
  }

  async setLabelColor(name: string, color: string) {
    const before = await this.findLabel(name);
    const after: Label = { name: before?.name ?? name, color };
    await this.db.labels.put(after);
    this.record({ table: 'labels', key: after.name, before, after }, 'Color de etiqueta cambiado');
    this.emit();
  }

  async renameLabel(from: string, to: string) {
    const target = to.trim().replace(/^\+/, '');
    if (!target || nameKey(from) === nameKey(target)) return;
    await this.batch(`Etiqueta renombrada a ${target}`, async () => {
      const label = await this.findLabel(from);
      if (label) {
        await this.db.labels.delete(label.name);
        this.record({ table: 'labels', key: label.name, before: label, after: undefined }, '');
        const renamed = { name: target, color: label.color };
        await this.db.labels.put(renamed);
        this.record({ table: 'labels', key: target, before: undefined, after: renamed }, '');
      }
      const tasks = await this.db.tasks.where('tags').anyOf(await this.tagVariants(from)).toArray();
      for (const t of tasks) {
        const tags = [...new Set(t.tags.map((g) => (nameKey(g) === nameKey(from) ? target : g)))];
        await this.patchTask(t.id, { tags }, '', false);
      }
    });
  }

  async deleteLabel(name: string) {
    await this.batch(`Etiqueta ${name} eliminada`, async () => {
      const label = await this.findLabel(name);
      if (label) {
        await this.db.labels.delete(label.name);
        this.record({ table: 'labels', key: label.name, before: label, after: undefined }, '');
      }
      const tasks = await this.db.tasks.where('tags').anyOf(await this.tagVariants(name)).toArray();
      for (const t of tasks) await this.patchTask(t.id, { tags: t.tags.filter((g) => nameKey(g) !== nameKey(name)) }, '', false);
    });
  }

  /** Escrituras distintas de una misma etiqueta presentes en las tareas ("Urgente", "urgente"…). */
  private async tagVariants(name: string) {
    const all = (await this.db.tasks.orderBy('tags').uniqueKeys()) as string[];
    return all.filter((g) => nameKey(g) === nameKey(name));
  }

  // ---------- Ajustes (fuera del historial: no son acciones sobre tareas) ----------

  async getSettings(): Promise<Settings> {
    const row = await this.db.settings.get(SETTINGS_KEY);
    const parsed = settingsSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async updateSettings(patch: Partial<Settings>) {
    const next = await this.writeSettings(patch);
    this.emit();
    return next;
  }

  async markBackup(at = new Date()) {
    await this.writeSettings({ last_backup_at: at.toISOString() });
  }

  private async writeSettings(patch: Partial<Settings>) {
    const current = await this.getSettings();
    const next: Settings = { ...current, ...patch, ui: { ...current.ui, ...patch.ui } };
    await this.db.settings.put({ key: SETTINGS_KEY, value: next });
    return next;
  }

  // ---------- Copias ----------

  async exportSnapshot(): Promise<Backup> {
    return {
      app: BACKUP_APP_ID,
      schema_version: SCHEMA_VERSION,
      exported_at: now(),
      projects: await this.db.projects.toArray(),
      tasks: await this.db.tasks.toArray(),
      settings: await this.getSettings(),
      labels: await this.db.labels.toArray(),
      item_types: await this.listItemTypes(),
      releases: await this.db.releases.toArray(),
      notes: await this.db.notes.toArray(),
      people: await this.db.people.toArray(),
      activity: await this.db.activity.toArray(),
    };
  }

  /** Sustituye todos los datos. Vacía el historial: deshacer no puede cruzar una importación. */
  async replaceAll(backup: Backup) {
    const tables = [this.db.projects, this.db.tasks, this.db.settings, this.db.labels, this.db.item_types, this.db.releases, this.db.notes, this.db.people, this.db.activity];
    await this.db.transaction('rw', tables, async () => {
      await Promise.all(tables.map((t) => t.clear()));
      await this.db.projects.bulkAdd(backup.projects);
      await this.db.tasks.bulkAdd(backup.tasks);
      await this.db.settings.put({ key: SETTINGS_KEY, value: backup.settings });
      await this.db.labels.bulkAdd(backup.labels);
      await this.db.item_types.bulkAdd(backup.item_types);
      await this.db.releases.bulkAdd(backup.releases);
      await this.db.notes.bulkAdd(backup.notes);
      await this.db.people.bulkAdd(backup.people);
      await this.db.activity.bulkAdd(backup.activity);
    });
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  async mergeBackup(backup: Backup): Promise<MergeResult> {
    const res: MergeResult = { projects: 0, tasks: 0, notes: 0, people: 0, skipped: 0 };
    const total = backup.tasks.length + backup.notes.length;
    await this.batch(`Importado: ${total} elementos`, async () => {
      // Proyectos: padres antes que hijos; se reutiliza el que tenga el mismo nombre bajo el mismo padre.
      const projectIds = new Map<string, string>();
      const existing = await this.db.projects.toArray();
      let pending = backup.projects;
      while (pending.length) {
        const ready = pending.filter((p) => !p.parent_id || projectIds.has(p.parent_id) || !pending.some((q) => q.id === p.parent_id));
        if (!ready.length) break;
        for (const p of ready) {
          const parent = p.parent_id ? projectIds.get(p.parent_id) ?? null : null;
          const match = existing.find((e) => nameKey(e.name) === nameKey(p.name) && (e.parent_id ?? null) === parent);
          if (match) projectIds.set(p.id, match.id);
          else {
            const created = await this.createProject(p.name, { color: p.color, parent_id: parent });
            existing.push(created);
            projectIds.set(p.id, created.id);
            res.projects++;
          }
        }
        pending = pending.filter((p) => !ready.includes(p));
      }
      const mapProject = (id: string | null) => (id ? projectIds.get(id) ?? null : null);

      const releaseIds = new Map<string, string>();
      const releases = await this.db.releases.toArray();
      for (const r of backup.releases) {
        const match = releases.find((e) => nameKey(e.name) === nameKey(r.name));
        const { id: _id, name, created_at: _c, ...fields } = r;
        releaseIds.set(r.id, match?.id ?? (await this.createRelease(name, { ...fields, project_id: mapProject(r.project_id) })).id);
      }

      for (const label of backup.labels) {
        if (!(await this.findLabel(label.name))) await this.setLabelColor(label.name, label.color);
      }

      // Personas: se completa lo que falte en la ficha existente.
      const people = await this.db.people.toArray();
      for (const p of backup.people) {
        const match = people.find((e) => nameKey(e.name) === nameKey(p.name));
        if (!match) { await this.savePerson(p); res.people++; continue; }
        const merged = { ...match, role: match.role || p.role, email: match.email || p.email, notes: match.notes || p.notes };
        if (JSON.stringify(merged) !== JSON.stringify(match)) await this.savePerson(merged);
      }

      const types = await this.listItemTypes();
      const tasks = await this.listTasks();
      const taskIds = new Map<string, string>();
      for (const t of backup.tasks.filter((x) => !x.deleted_at)) {
        const project_id = mapProject(t.project_id);
        const ext = t.external_id?.trim().toUpperCase();
        const match = tasks.find((e) => ext ? e.external_id?.trim().toUpperCase() === ext
          : nameKey(e.title) === nameKey(t.title) && e.project_id === project_id && e.type_id === t.type_id);
        if (match) { taskIds.set(t.id, match.id); res.skipped++; continue; }
        const { id: _id, created_at: _c, updated_at: _u, last_touched_at: _l, ...fields } = t;
        const created = await this.createTask({
          ...fields,
          type_id: types.some((x) => x.id === t.type_id) ? t.type_id : DEFAULT_TYPE_ID,
          project_id,
          release_id: t.release_id ? releaseIds.get(t.release_id) ?? null : null,
        }, { spaceDefault: false });
        tasks.push(created);
        taskIds.set(t.id, created.id);
        res.tasks++;
      }

      const notes = await this.listNotes();
      for (const n of backup.notes.filter((x) => !x.deleted_at)) {
        const project_id = mapProject(n.project_id);
        const task_id = n.task_id ? taskIds.get(n.task_id) ?? null : null;
        if (notes.some((e) => nameKey(e.title) === nameKey(n.title) && e.project_id === project_id && e.task_id === task_id)) { res.skipped++; continue; }
        const { id: _id, created_at: _c, updated_at: _u, people: _p, ...fields } = n;
        notes.push(await this.createNote({ ...fields, project_id, task_id }));
        res.notes++;
      }
    });
    return res;
  }

  // ---------- Meta (local al dispositivo) ----------

  async getMeta<T>(key: string) {
    return (await this.db.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown) {
    await this.db.meta.put({ key, value });
  }
}

export const repo = new DexieRepository();
