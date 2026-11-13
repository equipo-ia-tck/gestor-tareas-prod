import { z } from 'zod';
import { DEFAULT_SETTINGS, DEFAULT_TYPE_ID } from './types';
import { DEFAULT_ITEM_TYPES } from './workflows';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato YYYY-MM-DD');
const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Fecha y hora no válida');

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
});

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string(),
  parent_id: z.string().nullable().default(null),
  space_id: z.string().nullable().optional(),
  archived: z.boolean(),
  created_at: isoDateTime,
});

export const taskSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().nullable(),
  title: z.string(),
  notes: z.string().default(''),
  due_date: isoDate.nullable(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  estimated_minutes: z.number().int().min(0).nullable(),
  people: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  status: z.enum(['todo', 'done', 'archived']),
  // Campos v2: las copias v1 no los tienen y se completan al normalizar.
  type_id: z.string().default(DEFAULT_TYPE_ID),
  state_id: z.string().optional(),
  checklist: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })).default([]),
  // Campos v3.
  external_id: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  release_id: z.string().nullable().default(null),
  remind_at: isoDateTime.nullable().default(null),
  my_day: isoDate.nullable().default(null),
  board_column: z.string().nullable().default(null),
  recurrence_rule: recurrenceSchema.nullable().default(null),
  series_id: z.string().nullable().default(null),
  sort_order: z.number().default(0),
  raw_input: z.string().default(''),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  completed_at: isoDateTime.nullable(),
  last_touched_at: isoDateTime,
  deleted_at: isoDateTime.nullable().default(null),
}).transform((t) => ({
  ...t,
  // Copias v1: solo existía el tipo "Tarea"; el estado sale de status.
  state_id: t.state_id ?? (t.status === 'done' ? 'task-done' : 'task-todo'),
}));

export const taskFilterSchema = z.object({
  text: z.string().default(''),
  types: z.array(z.string()).default([]),
  categories: z.array(z.enum(['todo', 'doing', 'blocked', 'done', 'accepted'])).default([]),
  projects: z.array(z.string()).default([]),
  people: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  releases: z.array(z.string()).default([]),
  due: z.enum(['any', 'overdue', 'today', 'week', 'has', 'none']).default('any'),
  includeDone: z.boolean().default(false),
  groupBy: z.enum(['none', 'type', 'state', 'project', 'person', 'due']).default('type'),
});

export const settingsSchema = z.object({
  capacity_minutes: z.number().int().min(0).max(1440).default(DEFAULT_SETTINGS.capacity_minutes),
  workdays: z.array(z.number().int().min(0).max(6)).default(DEFAULT_SETTINGS.workdays),
  last_backup_at: isoDateTime.nullable().default(null),
  ui: z
    .object({
      summary_dismissed_on: isoDate.nullable().default(null),
      last_review_on: isoDate.nullable().default(null),
    })
    .default(DEFAULT_SETTINGS.ui),
  saved_views: z.array(z.object({ id: z.string(), name: z.string(), filter: taskFilterSchema })).default([]),
  groups: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), color: z.string() })).default([]),
  rally_templates: z.array(z.object({ id: z.string().min(1), label: z.string(), text: z.string() })).nullable().default(null),
});

const stateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
  category: z.enum(['todo', 'doing', 'blocked', 'done', 'accepted']),
});

export const itemTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  short: z.string().default(''),
  color: z.string(),
  order: z.number().default(0),
  states: z.array(stateSchema).min(1),
  url_template: z.string().optional(),
});

export const releaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  date: isoDate.nullable(),
  project_id: z.string().nullable(),
  status: z.enum(['planned', 'released', 'cancelled']),
  notes: z.string().default(''),
  created_at: isoDateTime,
});

export const labelSchema = z.object({ name: z.string().min(1), color: z.string() });

export const noteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  kind: z.enum(['meeting', 'note']),
  date: isoDate,
  project_id: z.string().nullable(),
  people: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  task_id: z.string().nullable().default(null),
  meeting_url: z.string().nullable().default(null),
  sort_order: z.number().nullable().default(null),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  deleted_at: isoDateTime.nullable().default(null),
});

export const personSchema = z.object({ name: z.string().min(1), role: z.string().default(''), notes: z.string().default(''), email: z.string().default(''), group_id: z.string().nullable().optional() });

export const activitySchema = z.object({
  id: z.string().min(1),
  at: isoDateTime,
  date: isoDate,
  kind: z.enum(['created', 'completed', 'reopened', 'postponed', 'deleted', 'archived', 'state']),
  task_id: z.string(),
  title: z.string(),
  project_id: z.string().nullable(),
  from: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
});

export const BACKUP_APP_ID = 'gestor-tareas';

export const backupSchema = z.object({
  app: z.literal(BACKUP_APP_ID),
  schema_version: z.number().int().min(1),
  exported_at: isoDateTime,
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  settings: settingsSchema,
  labels: z.array(labelSchema).default([]),
  item_types: z.array(itemTypeSchema).default(DEFAULT_ITEM_TYPES),
  releases: z.array(releaseSchema).default([]),
  notes: z.array(noteSchema).default([]),
  people: z.array(personSchema).default([]),
  activity: z.array(activitySchema).default([]),
});

export type Backup = z.infer<typeof backupSchema>;
