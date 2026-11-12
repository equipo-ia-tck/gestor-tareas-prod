import { isActive } from './selectors';
import { nameKey } from './text';
import type { Note, Person, PersonGroup, Task } from './types';

export interface PersonEntry {
  name: string;
  /** Tareas pendientes en las que aparece. */
  tasks: number;
  /** Notas o actas que la mencionan con @. */
  notes: number;
  /** Tareas pendientes enlazadas con Rally de las que es Owner allí (sin contar las que ya la tienen en Personas). */
  rally: number;
}

/**
 * Todas las personas que aparecen en la app: en tareas, mencionadas en notas, con ficha o Owners en Rally de las tareas
 * enlazadas (`rallyOwners`: id de tarea → Owner; no cambia las tareas, así no se comparten con nadie por el nombre).
 * Se unen por nombre (sin mayúsculas, tildes ni guiones). El nombre que se muestra es el de la
 * ficha si la hay, si no el de las tareas y, por último, el de la nota.
 */
export function peopleDirectory(tasks: Task[], notes: Note[], cards: Person[], rallyOwners: Map<string, string> = new Map()): PersonEntry[] {
  const map = new Map<string, PersonEntry & { rank: number }>();
  const touch = (name: string, rank: number) => {
    const k = nameKey(name);
    const e = map.get(k) ?? { name, tasks: 0, notes: 0, rally: 0, rank };
    if (rank < e.rank) { e.name = name; e.rank = rank; }
    map.set(k, e);
    return e;
  };
  for (const c of cards) touch(c.name, 0);
  for (const t of tasks) for (const p of t.people) { const e = touch(p, 1); if (isActive(t)) e.tasks++; }
  for (const n of notes) if (!n.deleted_at) for (const p of n.people) touch(p, 2).notes++;
  for (const t of tasks) {
    const owner = rallyOwners.get(t.id);
    if (!owner) continue;
    const e = touch(owner, 3);
    if (isActive(t) && !t.people.some((p) => nameKey(p) === nameKey(owner))) e.rally++;
  }
  return [...map.values()]
    .map(({ name, tasks: t, notes: n, rally: r }) => ({ name, tasks: t, notes: n, rally: r }))
    .sort((a, b) => b.tasks + b.rally - (a.tasks + a.rally) || b.notes - a.notes || a.name.localeCompare(b.name, 'es'));
}

/** Cambia las menciones @de por @a en un texto (sin importar mayúsculas, tildes ni guiones). */
export function renameMentions(body: string, from: string, to: string): string {
  const target = `@${to.trim().replace(/\s+/g, '-')}`;
  return body.replace(/(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_\-.]*[\p{L}\p{N}_])/gu, (m, token: string) =>
    (nameKey(token) === nameKey(from) ? target : m));
}

/** Quita las menciones a `name` de una nota: «@Diana-Pérez» pasa a ser texto normal («Diana Pérez»). */
export function dropMentions(body: string, name: string): string {
  return body.replace(/(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_\-.]*[\p{L}\p{N}_])/gu, (m, token: string) =>
    (nameKey(token) === nameKey(name) ? name : m));
}

/** Lista de personas de una tarea con `de` sustituida por `a` (sin duplicados). */
export function renameInList(people: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (const p of people.map((x) => (nameKey(x) === nameKey(from) ? to : x))) {
    if (!out.some((o) => nameKey(o) === nameKey(p))) out.push(p);
  }
  return out;
}

export interface GroupSection<T extends { name: string }> {
  /** Null = "Sin grupo". */
  group: PersonGroup | null;
  people: T[];
}

/** Grupo de una persona según su ficha; null si no tiene o si el grupo ya no existe. */
export function groupOf(name: string, cards: Person[], groups: PersonGroup[]): PersonGroup | null {
  const id = cards.find((c) => nameKey(c.name) === nameKey(name))?.group_id;
  return (id && groups.find((g) => g.id === id)) || null;
}

/**
 * Reparte las personas en sus grupos, en el orden de los grupos y conservando el de la lista dentro de cada uno.
 * Siempre salen todos los grupos (aunque estén vacíos) y, al final, "Sin grupo" si hay alguien sin grupo.
 */
export function groupPeople<T extends { name: string }>(people: T[], cards: Person[], groups: PersonGroup[]): GroupSection<T>[] {
  const sections: GroupSection<T>[] = groups.map((group) => ({ group, people: [] }));
  const none: T[] = [];
  for (const p of people) {
    const g = groupOf(p.name, cards, groups);
    if (g) sections[groups.indexOf(g)].people.push(p);
    else none.push(p);
  }
  if (none.length) sections.push({ group: null, people: none });
  return sections;
}

/** Persona que sale en las tarjetas pendientes de un proyecto, con los ids de esas tareas. */
export interface BoardPerson { name: string; taskIds: string[] }

/**
 * Personas de un tablero (proyecto): las de `task.people` y el Owner de Rally de las tareas enlazadas (`ownerOf`, id de
 * la tarea → nombre), solo de las pendientes. Una vez por persona (por `nameKey`), de más a menos tareas y por nombre.
 */
export function boardPeople(tasks: Task[], ownerOf: (taskId: string) => string | undefined): BoardPerson[] {
  const byKey = new Map<string, BoardPerson>();
  for (const t of tasks) {
    if (!isActive(t)) continue;
    const owner = ownerOf(t.id);
    for (const name of owner ? [...t.people, owner] : t.people) {
      const key = nameKey(name);
      if (!key) continue;
      const entry = byKey.get(key) ?? byKey.set(key, { name, taskIds: [] }).get(key)!;
      if (!entry.taskIds.includes(t.id)) entry.taskIds.push(t.id);
    }
  }
  return [...byKey.values()].sort((a, b) => b.taskIds.length - a.taskIds.length || a.name.localeCompare(b.name, 'es'));
}
