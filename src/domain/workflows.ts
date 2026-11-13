import { DEFAULT_TYPE_ID, TOPIC_TYPE_ID, type ItemType, type StateCategory, type Task, type WorkflowState } from './types';

export const DEFAULT_ITEM_TYPES: ItemType[] = [
  {
    id: DEFAULT_TYPE_ID, name: 'Tarea', short: '', color: '#6366f1', order: 0,
    states: [
      { id: 'task-todo', name: 'Por hacer', color: '#94a3b8', category: 'todo' },
      { id: 'task-doing', name: 'En curso', color: '#3b82f6', category: 'doing' },
      { id: 'task-blocked', name: 'Bloqueada', color: '#ef4444', category: 'blocked' },
      { id: 'task-done', name: 'Hecha', color: '#22c55e', category: 'done' },
      { id: 'task-accepted', name: 'Accepted', color: '#047857', category: 'accepted' },
    ],
  },
  {
    id: 'us', name: 'User Story', short: 'US', color: '#0ea5e9', order: 1,
    states: [
      { id: 'us-backlog', name: 'Backlog', color: '#94a3b8', category: 'todo' },
      { id: 'us-refined', name: 'Refinada', color: '#8b5cf6', category: 'todo' },
      { id: 'us-dev', name: 'En desarrollo', color: '#3b82f6', category: 'doing' },
      { id: 'us-qa', name: 'En QA', color: '#f59e0b', category: 'doing' },
      { id: 'us-blocked', name: 'Bloqueada', color: '#ef4444', category: 'blocked' },
      { id: 'us-validated', name: 'Validada', color: '#14b8a6', category: 'doing' },
      { id: 'us-prod', name: 'En producción', color: '#22c55e', category: 'done' },
      { id: 'us-accepted', name: 'Accepted', color: '#047857', category: 'accepted' },
    ],
  },
  {
    id: 'ts', name: 'Test Scenario', short: 'TS', color: '#ec4899', order: 2,
    states: [
      { id: 'ts-todo', name: 'Por diseñar', color: '#94a3b8', category: 'todo' },
      { id: 'ts-designed', name: 'Diseñado', color: '#8b5cf6', category: 'todo' },
      { id: 'ts-running', name: 'En ejecución', color: '#3b82f6', category: 'doing' },
      { id: 'ts-failed', name: 'Fallido', color: '#f97316', category: 'blocked' },
      { id: 'ts-blocked', name: 'Bloqueado', color: '#ef4444', category: 'blocked' },
      { id: 'ts-passed', name: 'Pasado', color: '#22c55e', category: 'done' },
      { id: 'ts-accepted', name: 'Accepted', color: '#047857', category: 'accepted' },
    ],
  },
  {
    id: TOPIC_TYPE_ID, name: 'Para hablar', short: 'HABLAR', color: '#f59e0b', order: 3,
    states: [
      { id: 'topic-pending', name: 'Pendiente', color: '#f59e0b', category: 'todo' },
      { id: 'topic-done', name: 'Hablado', color: '#22c55e', category: 'done' },
    ],
  },
];

export const TOPIC_TYPE = DEFAULT_ITEM_TYPES.find((t) => t.id === TOPIC_TYPE_ID)!;

export const findType = (types: ItemType[], id: string | undefined): ItemType =>
  types.find((t) => t.id === id) ?? types.find((t) => t.id === DEFAULT_TYPE_ID) ?? DEFAULT_ITEM_TYPES[0];

/** Categorías que cuentan como completada. */
export const isDoneCategory = (cat: StateCategory) => cat === 'done' || cat === 'accepted';

/** Tipos que llevan el estado "Accepted" (los de serie salvo "Para hablar"). */
export const ACCEPTED_TYPE_IDS = [DEFAULT_TYPE_ID, 'us', 'ts'];

/** El tipo con el estado "Accepted" al final si aún no tiene ninguno de esa categoría (null si no hace falta). */
export function withAcceptedState(type: ItemType): ItemType | null {
  if (!ACCEPTED_TYPE_IDS.includes(type.id) || type.states.some((s) => s.category === 'accepted')) return null;
  return { ...type, states: [...type.states, { id: `${type.id}-accepted`, name: 'Accepted', color: '#047857', category: 'accepted' }] };
}

const firstOf = (type: ItemType, cat: StateCategory) => type.states.find((s) => s.category === cat);

/** Estado inicial de un tipo (el primero pendiente). */
export const initialState = (type: ItemType): WorkflowState => firstOf(type, 'todo') ?? type.states[0];
/** Estado al completar (el primero de categoría "done"). */
export const doneState = (type: ItemType): WorkflowState => firstOf(type, 'done') ?? type.states[type.states.length - 1];

export function stateOf(types: ItemType[], task: Pick<Task, 'type_id' | 'state_id' | 'status'>): WorkflowState {
  const type = findType(types, task.type_id);
  return type.states.find((s) => s.id === task.state_id) ?? (task.status === 'done' ? doneState(type) : initialState(type));
}

/**
 * Estado de un tipo para una columna del tablero de categoría `cat`. Si el tipo no tiene esa categoría (Para hablar solo
 * tiene Pendiente y Hablado): Accepted → su estado hecho; Bloqueado o En curso → su estado inicial.
 */
export function stateForCategory(type: ItemType, cat: StateCategory): WorkflowState {
  return firstOf(type, cat) ?? (isDoneCategory(cat) ? doneState(type) : initialState(type));
}

/** Estado del nuevo tipo con la misma categoría que el actual (al cambiar una tarea de tipo). */
export function equivalentState(from: WorkflowState, to: ItemType): WorkflowState {
  return firstOf(to, from.category) ?? (isDoneCategory(from.category) ? doneState(to) : initialState(to));
}

/**
 * Cambios coherentes al mover una tarea a un estado: completarla si el estado es de "hecho",
 * reabrirla si sale de él. Las archivadas no cambian de status.
 */
export function patchForState(task: Pick<Task, 'status' | 'completed_at'>, state: WorkflowState, nowIso: string) {
  if (isDoneCategory(state.category)) {
    return { state_id: state.id, status: 'done' as const, completed_at: task.status === 'done' ? task.completed_at : nowIso };
  }
  return {
    state_id: state.id,
    ...(task.status === 'done' ? { status: 'todo' as const, completed_at: null } : {}),
  };
}
