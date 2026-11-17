import { useMemo } from 'react';
import { repo } from '../data/services';
import { isRallyId } from '../domain/rally';
import type { ISODate, Task, TaskPatch } from '../domain/types';

/**
 * Las tareas enlazadas a Rally también se mueven en Rally al completarlas o reabrirlas (y Rally avisa): con un clic sin querer
 * se puede liar, así que se pregunta antes. True si se puede seguir.
 */
export function confirmRallyToggle(tasks: Task[], done: boolean): boolean {
  const rally = tasks.filter((t) => isRallyId(t.external_id));
  if (!rally.length) return true;
  const what = rally.length === 1 ? `${rally[0].external_id} · ${rally[0].title}` : `${rally.length} elementos de Rally`;
  return window.confirm(`¿${done ? 'Completar' : 'Reabrir'} ${what}?\n\nTambién se ${rally.length === 1 ? 'moverá' : 'moverán'} en Rally (${done ? 'a Completed' : 'fuera de Completed'}).`);
}

const n = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

/** Acciones sobre una o varias tareas. Cada una es una sola entrada del historial. */
export function useTaskActions() {
  return useMemo(() => ({
    async toggleDone(tasks: Task[]) {
      if (!tasks.length) return;
      const done = tasks.some((t) => t.status !== 'done');
      if (!confirmRallyToggle(tasks, done)) return;
      // Una sola: el repositorio pone la etiqueta (incluye "se repite…" en las recurrentes).
      if (tasks.length === 1) return repo.setCompleted(tasks[0].id, done);
      await repo.batch(
        done ? n(tasks.length, 'Tarea completada', 'tareas completadas') : n(tasks.length, 'Tarea pendiente', 'tareas pendientes'),
        async () => { for (const t of tasks) await repo.setCompleted(t.id, done); },
      );
    },
    async remove(tasks: Task[]) {
      if (!tasks.length) return;
      await repo.batch(n(tasks.length, 'Tarea eliminada', 'tareas eliminadas'), async () => {
        for (const t of tasks) await repo.deleteTask(t.id);
      });
    },
    async reschedule(tasks: Task[], due: ISODate | null) {
      if (!tasks.length) return;
      const label = due ? n(tasks.length, 'Fecha cambiada', 'tareas reprogramadas') : n(tasks.length, 'Fecha quitada', 'tareas sin fecha');
      await repo.batch(label, async () => { for (const t of tasks) await repo.updateTask(t.id, { due_date: due }); });
    },
    /** Para arrastrar y soltar: se reciben ids. */
    async moveIds(ids: string[], patch: TaskPatch, label: string) {
      if (!ids.length) return;
      const plural = label.startsWith('Movida') ? `${ids.length} tareas movidas${label.slice('Movida'.length)}` : `${ids.length} tareas actualizadas`;
      await repo.batch(ids.length === 1 ? label : plural, async () => {
        for (const id of ids) await repo.updateTask(id, patch);
      });
    },
    /** Añade o quita de "Mi día" (si alguna no está, las añade todas). */
    async toggleMyDay(tasks: Task[], today: ISODate) {
      if (!tasks.length) return;
      const add = tasks.some((t) => t.my_day !== today);
      await repo.batch(add ? n(tasks.length, 'Añadida a Mi día', 'añadidas a Mi día') : n(tasks.length, 'Quitada de Mi día', 'quitadas de Mi día'), async () => {
        for (const t of tasks) await repo.updateTask(t.id, { my_day: add ? today : null });
      });
    },
    async update(tasks: Task[], patch: TaskPatch, label = 'Tarea actualizada') {
      if (!tasks.length) return;
      await repo.batch(tasks.length === 1 ? label : `${tasks.length} tareas actualizadas`, async () => {
        for (const t of tasks) await repo.updateTask(t.id, patch);
      });
    },
  }), []);
}
