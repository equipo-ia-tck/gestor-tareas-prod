import { addDays, formatDay } from './dates';
import { projectPath, withDescendants } from './projects';
import { sortTasks } from './selectors';
import { fold, nameKey } from './text';
import type { GroupBy, ISODate, ItemType, Project, Task, TaskFilter } from './types';
import { findType, stateOf } from './workflows';

export const EMPTY_FILTER: TaskFilter = {
  text: '', types: [], categories: [], projects: [], people: [], tags: [], releases: [],
  due: 'any', includeDone: false, groupBy: 'type',
};

/** Número de filtros activos (para la insignia del botón). */
export function activeFilterCount(f: TaskFilter): number {
  return [f.text.trim(), f.types.length, f.categories.length, f.projects.length, f.people.length, f.tags.length, f.releases.length,
    f.due !== 'any', f.includeDone].filter(Boolean).length;
}

interface Ctx {
  today: ISODate;
  projects: Project[];
  types: ItemType[];
}

/** Aplica el filtro de la vista "Todo". */
export function applyFilter(tasks: Task[], f: TaskFilter, ctx: Ctx): Task[] {
  const projectIds = f.projects.length ? new Set(f.projects.flatMap((id) => [...withDescendants(id, ctx.projects)])) : null;
  const words = fold(f.text).split(/\s+/).filter(Boolean);
  const wantsDone = f.includeDone || f.categories.includes('done');
  const weekEnd = addDays(ctx.today, 6);
  return sortTasks(tasks.filter((t) => {
    if (t.deleted_at || t.status === 'archived') return false;
    if (t.status === 'done' && !wantsDone) return false;
    if (f.types.length && !f.types.includes(findType(ctx.types, t.type_id).id)) return false;
    if (f.categories.length && !f.categories.includes(stateOf(ctx.types, t).category)) return false;
    if (projectIds && !(t.project_id && projectIds.has(t.project_id))) return false;
    if (f.people.length && !f.people.some((p) => t.people.some((x) => nameKey(x) === nameKey(p)))) return false;
    if (f.tags.length && !f.tags.some((g) => t.tags.some((x) => nameKey(x) === nameKey(g)))) return false;
    if (f.releases.length && !(t.release_id && f.releases.includes(t.release_id))) return false;
    switch (f.due) {
      case 'overdue': if (!(t.due_date && t.due_date < ctx.today && t.status === 'todo')) return false; break;
      case 'today': if (t.due_date !== ctx.today) return false; break;
      case 'week': if (!(t.due_date && t.due_date >= ctx.today && t.due_date <= weekEnd)) return false; break;
      case 'has': if (!t.due_date) return false; break;
      case 'none': if (t.due_date) return false; break;
    }
    if (words.length) {
      const hay = fold([t.title, t.notes, t.external_id ?? '', ...t.tags, ...t.people, ...t.checklist.map((c) => c.text)].join(' '));
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }));
}

export interface TaskGroup {
  key: string;
  label: string;
  color?: string;
  tasks: Task[];
}

/** Agrupa el resultado. Una tarea con varias personas aparece en el grupo de cada una. */
export function groupTasks(tasks: Task[], by: GroupBy, ctx: Ctx): TaskGroup[] {
  if (by === 'none') return [{ key: 'all', label: 'Todas', tasks }];
  const map = new Map(ctx.projects.map((p) => [p.id, p]));
  const groups = new Map<string, TaskGroup>();
  const add = (key: string, label: string, t: Task, color?: string) => {
    const g = groups.get(key) ?? { key, label, color, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  };
  const order: string[] = [];
  if (by === 'type') order.push(...ctx.types.map((t) => t.id));
  if (by === 'state') order.push(...ctx.types.flatMap((t) => t.states.map((s) => s.id)));
  if (by === 'due') order.push('overdue', 'today', 'week', 'later', 'none');

  for (const t of tasks) {
    switch (by) {
      case 'type': { const type = findType(ctx.types, t.type_id); add(type.id, type.name, t, type.color); break; }
      case 'state': {
        const type = findType(ctx.types, t.type_id);
        const s = stateOf(ctx.types, t);
        add(s.id, type.short ? `${type.short} · ${s.name}` : s.name, t, s.color);
        break;
      }
      case 'project': {
        const p = t.project_id ? map.get(t.project_id) : undefined;
        if (p) add(p.id, projectPath(p.id, map), t, p.color); else add('~none', 'Sin proyecto', t);
        break;
      }
      case 'person':
        if (!t.people.length) add('~none', 'Sin persona', t);
        for (const p of t.people) add(nameKey(p), p, t);
        break;
      case 'due': {
        const d = t.due_date;
        if (!d) add('none', 'Sin fecha', t);
        else if (d < ctx.today) add('overdue', 'Atrasadas', t, '#f59e0b');
        else if (d === ctx.today) add('today', 'Hoy', t, '#2E6BE6');
        else if (d <= addDays(ctx.today, 6)) add('week', 'Esta semana', t);
        else add('later', `Más adelante (desde ${formatDay(addDays(ctx.today, 7), ctx.today).toLowerCase()})`, t);
        break;
      }
    }
  }
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return [...groups.values()].sort((a, b) =>
    rank(a.key) - rank(b.key) || Number(a.key.startsWith('~')) - Number(b.key.startsWith('~')) || a.label.localeCompare(b.label, 'es'));
}
