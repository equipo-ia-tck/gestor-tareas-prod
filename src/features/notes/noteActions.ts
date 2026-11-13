import { repo } from '../../data/services';
import { actionItems, plainLine, setChecked, setTaskMarker, type ActionItem } from '../../domain/markdown';
import type { NewTask, Note, Task } from '../../domain/types';
import type { CaptureContext } from '../../parser/types';
import { parseCapture } from '../../parser/parseCapture';
import { submitCapture } from '../capture/submitCapture';

const fromNote = (note: Note) => `De: ${note.title || 'nota'} (${note.date.split('-').reverse().join('/')})`;

/**
 * Convierte en tareas las acciones (`- [ ] …`) que aún no lo son. Cada acción pasa por el
 * parser de captura (admite @persona, fechas, !1…) y la línea queda enlazada con [[t:id]].
 * Todo es una sola entrada del historial.
 */
export async function createTasksFromActions(note: Note, ctx: CaptureContext, only?: ActionItem): Promise<number> {
  const pending = actionItems(note.body).filter((a) => !a.taskId && (!only || a.line === only.line));
  if (!pending.length) return 0;
  let created = 0;
  await repo.batch(pending.length === 1 ? 'Acción convertida en tarea' : `${pending.length} acciones convertidas en tareas`, async () => {
    let body = note.body;
    for (const a of pending) {
      const parsed = parseCapture(a.text, ctx).filter((p) => p.title);
      if (!parsed.length) continue;
      const [task] = await submitCapture(parsed.slice(0, 1), { project_id: note.project_id, notes: fromNote(note) });
      if (a.checked) await repo.setCompleted(task.id, true);
      body = setTaskMarker(body, a.line, task.id);
      created++;
    }
    await repo.updateNote(note.id, { body });
  });
  return created;
}

/** Marca o desmarca una acción. Si está enlazada, completa o reabre también la tarea. */
export async function toggleAction(note: Note, line: number, taskId: string | null, tasks: Map<string, Task>) {
  const task = taskId ? tasks.get(taskId) : undefined;
  const checked = task ? task.status !== 'done' : !actionItems(note.body).find((a) => a.line === line)?.checked;
  await repo.batch(checked ? 'Acción hecha' : 'Acción pendiente', async () => {
    if (task) await repo.setCompleted(task.id, checked);
    await repo.updateNote(note.id, { body: setChecked(note.body, line, checked) });
  });
}

/**
 * Convierte una línea de una nota (con @persona o #proyecto) en tarea: pasa por el parser de captura (persona,
 * proyecto, fecha, !1…) y la línea queda enlazada con [[t:id]], así no se vuelve a ofrecer. Sin #proyecto, la tarea va
 * al de `defaults` o al de la nota. Un solo "Deshacer".
 */
export async function createTaskFromLine(note: Note, line: number, ctx: CaptureContext, defaults: Partial<NewTask> = {}, label = 'Tarea creada desde la nota'): Promise<Task | null> {
  const raw = note.body.split('\n')[line];
  if (raw === undefined) return null;
  // "@Diana: revisar…" → "@Diana revisar…" (la persona va al campo Personas y no se queda un ":" suelto).
  const text = plainLine(raw).replace(/^(@[\p{L}\p{N}_\-.]*[\p{L}\p{N}_])\s*[:,]\s*/u, '$1 ');
  const parsed = parseCapture(text, ctx).filter((p) => p.title);
  if (!parsed.length) return null;
  let task: Task | null = null;
  await repo.batch(label, async () => {
    [task] = await submitCapture(parsed.slice(0, 1), { project_id: note.project_id, notes: fromNote(note), ...defaults });
    await repo.updateNote(note.id, { body: setTaskMarker(note.body, line, task.id) });
  });
  return task;
}
