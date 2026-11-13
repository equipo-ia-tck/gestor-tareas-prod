/** Fecha local sin hora, formato YYYY-MM-DD. Evita errores de zona horaria. */
export type ISODate = string;
/** Marca de tiempo ISO 8601 completa. */
export type ISODateTime = string;

export type TaskStatus = 'todo' | 'done' | 'archived';
export type Priority = 1 | 2 | 3 | 4;

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  /** 0 = domingo … 6 = sábado. Solo para freq 'weekly'. */
  weekdays?: number[];
  /** Día del mes (1-31). Solo para freq 'monthly'. */
  monthDay?: number;
}

/** Grupo de un estado: decide si cuenta como pendiente, en curso, bloqueado o terminado. */
/** "accepted" (validado por quien lo pidió, como en Rally) cuenta como completada, igual que "done". */
export type StateCategory = 'todo' | 'doing' | 'blocked' | 'done' | 'accepted';

export interface WorkflowState {
  id: string;
  name: string;
  color: string;
  category: StateCategory;
}

/** Tipo de elemento (Tarea, User Story, Test Scenario…) con su propio flujo de estados. */
export interface ItemType {
  id: string;
  name: string;
  /** Abreviatura para chips: "US", "TS". Vacía para las tareas normales. */
  short: string;
  color: string;
  order: number;
  states: WorkflowState[];
  /**
   * Plantilla para enlazar el ID externo, p. ej. "https://empresa.atlassian.net/browse/{id}".
   * Vacía = sin enlace automático.
   */
  url_template?: string;
}

export type ReleaseStatus = 'planned' | 'released' | 'cancelled';

/** Entrega o versión con fecha ("cuándo sale todo"). */
export interface Release {
  id: string;
  name: string;
  date: ISODate | null;
  project_id: string | null;
  status: ReleaseStatus;
  notes: string;
  created_at: ISODateTime;
}

/** Paso dentro de una tarea (como en Microsoft To Do). */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** Color personalizado de una etiqueta. Las etiquetas sin fila usan un color derivado del nombre. */
export interface Label {
  name: string;
  color: string;
}

export type ActivityKind = 'created' | 'completed' | 'reopened' | 'postponed' | 'deleted' | 'archived' | 'state';

/** Apunte del registro diario. Se genera solo al cambiar tareas; entra en el historial (deshacer lo quita). */
export interface ActivityEntry {
  id: string;
  at: ISODateTime;
  /** Día local del apunte. */
  date: ISODate;
  kind: ActivityKind;
  task_id: string;
  title: string;
  project_id: string | null;
  /** Fecha o estado anterior (pospuestas y cambios de estado). */
  from: string | null;
  to: string | null;
}

export type NoteKind = 'meeting' | 'note';

/** Nota o acta de reunión en Markdown. Las acciones (`- [ ] …`) pueden enlazarse a tareas con `[[t:id]]`. */
export interface Note {
  id: string;
  title: string;
  body: string;
  kind: NoteKind;
  date: ISODate;
  project_id: string | null;
  /** Personas mencionadas con @ en el cuerpo (se recalcula al guardar; sirve de índice). */
  people: string[];
  pinned: boolean;
  /** Nota de un elemento (US, TS, tarea…): aparece en su panel, en su proyecto y en Notas. */
  task_id: string | null;
  /** Enlace de la reunión (Teams, Meet…). */
  meeting_url: string | null;
  /** Orden manual de la página dentro de su sección (como en OneNote). null = por fecha de creación. */
  sort_order: number | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  deleted_at: ISODateTime | null;
}

/** Ficha de una persona. El nombre es la clave (el mismo que en @persona). */
export interface Person {
  name: string;
  role: string;
  notes: string;
  /** Para abrir un chat de Teams con la persona. */
  email: string;
  /** Grupo al que pertenece (`Settings.groups`). Null o un id que ya no existe = sin grupo. */
  group_id?: string | null;
}

/** Grupo de personas (equipo, cliente, área…). Se guarda en los ajustes de cada usuario. */
export interface PersonGroup {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  created_at: ISODateTime;
  /** Proyecto padre (subproyectos, hasta 3 niveles). */
  parent_id: string | null;
  /** Espacio de equipo (sus miembros lo ven todo). Null = personal; los subproyectos heredan el del padre. */
  space_id?: string | null;
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  notes: string;
  due_date: ISODate | null;
  priority: Priority;
  estimated_minutes: number | null;
  people: string[];
  tags: string[];
  /** Fuente de verdad de "pendiente/completada/archivada"; se mantiene sincronizado con el estado del flujo. */
  status: TaskStatus;
  type_id: string;
  state_id: string;
  checklist: ChecklistItem[];
  /** ID en otra herramienta (Jira, Xray, Azure DevOps…), p. ej. "US-1234". */
  external_id: string | null;
  /** Enlace explícito; si no hay, se construye con la plantilla del tipo. */
  url: string | null;
  release_id: string | null;
  /** Fecha y hora del aviso (ISO). Se pone a null al atenderlo. */
  remind_at: ISODateTime | null;
  /** Día en que se añadió a "Mi día" (como en Microsoft To Do). Solo cuenta si es hoy. */
  my_day: ISODate | null;
  /**
   * Columna del tablero «Como en Rally» en la que se soltó la tarea (New, Defined, Need Review…). Solo cuenta para las que
   * no están en Rally y mientras sigan en el grupo de esa columna; si no, van a la columna de su grupo.
   */
  board_column: string | null;
  recurrence_rule: RecurrenceRule | null;
  /** Enlaza las ocurrencias de una misma tarea recurrente. */
  series_id: string | null;
  /** Orden manual dentro de una lista (arrastrar y soltar). */
  sort_order: number;
  raw_input: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  completed_at: ISODateTime | null;
  last_touched_at: ISODateTime;
  /** Borrado suave: permite deshacer. Se purga pasados 30 días. */
  deleted_at: ISODateTime | null;
}

export interface Settings {
  capacity_minutes: number;
  /** 0 = domingo … 6 = sábado. */
  workdays: number[];
  last_backup_at: ISODateTime | null;
  ui: {
    summary_dismissed_on: ISODate | null;
    /** Último día en que se completó la revisión semanal. */
    last_review_on: ISODate | null;
  };
  /** Vistas guardadas de "Todo" (filtros con nombre). */
  saved_views: SavedView[];
  /** Grupos de personas, en el orden en que se muestran. */
  groups: PersonGroup[];
  /** Plantillas propias de «Crear con petición» (Rally), en su orden; null = las de serie. */
  rally_templates: RequestTemplate[] | null;
}

/** Plantilla de «Crear con petición»: un nombre y la frase. */
export interface RequestTemplate {
  id: string;
  label: string;
  text: string;
}

export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'has' | 'none';
export type GroupBy = 'none' | 'type' | 'state' | 'project' | 'person' | 'due';

/** Filtro de la vista "Todo". Listas vacías = sin filtrar por ese campo. */
export interface TaskFilter {
  text: string;
  types: string[];
  categories: StateCategory[];
  /** Incluye los subproyectos de cada proyecto elegido. */
  projects: string[];
  people: string[];
  tags: string[];
  releases: string[];
  due: DueFilter;
  includeDone: boolean;
  groupBy: GroupBy;
}

export interface SavedView {
  id: string;
  name: string;
  filter: TaskFilter;
}

export const DEFAULT_SETTINGS: Settings = {
  capacity_minutes: 360,
  workdays: [1, 2, 3, 4, 5],
  last_backup_at: null,
  ui: { summary_dismissed_on: null, last_review_on: null },
  saved_views: [],
  groups: [],
  rally_templates: null,
};

export type NewTask = Partial<Omit<Task, 'id' | 'created_at' | 'updated_at' | 'last_touched_at'>> & {
  title: string;
};

export type TaskPatch = Partial<Omit<Task, 'id' | 'created_at'>>;

export const DEFAULT_TYPE_ID = 'task';
/** Tipo para los temas pendientes de hablar con alguien. */
export const TOPIC_TYPE_ID = 'topic';

export const PROJECT_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#8b5cf6', '#14b8a6', '#84cc16', '#f97316',
];
