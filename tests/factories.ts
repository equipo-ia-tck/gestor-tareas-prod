import type { Task } from '../src/domain/types';

let n = 0;

export function makeTask(overrides: Partial<Task> = {}): Task {
  n += 1;
  const ts = '2026-10-01T09:00:00.000Z';
  return {
    id: `t${n}`,
    project_id: null,
    title: `Tarea ${n}`,
    notes: '',
    due_date: null,
    priority: 4,
    estimated_minutes: null,
    people: [],
    tags: [],
    status: overrides.status ?? 'todo',
    type_id: 'task',
    state_id: overrides.status === 'done' ? 'task-done' : 'task-todo',
    checklist: [],
    external_id: null,
    url: null,
    release_id: null,
    remind_at: null,
    my_day: null,
    board_column: null,
    recurrence_rule: null,
    series_id: null,
    sort_order: n,
    raw_input: '',
    created_at: ts,
    updated_at: ts,
    completed_at: null,
    last_touched_at: ts,
    deleted_at: null,
    ...overrides,
  };
}
