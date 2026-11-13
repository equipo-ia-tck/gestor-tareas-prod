import { repo } from '../../data/services';
import type { HistoryEntry, HistoryEvent } from '../../data/repository';
import { rallyIdsOf, rallyMoves, rallyPushes, type RallyCategory, type RallyItem, type RallyRef } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { rallyApi } from './rallyApi';
import { askAnalyst } from './AnalystPrompt';
import { askNeedReview } from './NeedReviewPrompt';
import { DONE_COMMENT } from './doneComment';
import { askMeeting } from './MeetingPrompt';
import { rallyItem, rememberRally } from './rallyStore';

let running = false;
/** Mientras se aplican cambios que vienen de Rally, el historial no los vuelve a mandar a Rally. */
let applying = false;
/** IDs que se están moviendo en Rally: hasta que termine, lo que llegue de Rally no los toca. */
const pending = new Set<string>();
/**
 * Entradas del historial que vinieron de Rally: deshacerlas (o rehacerlas) solo cambia el gestor, para no revertir en
 * Rally lo que hizo otra persona.
 */
const fromRally = new WeakSet<HistoryEntry>();

/**
 * Pone cada tarea enlazada con Rally en la categoría que tiene allí (Rally manda), en un solo "Deshacer". Con `items`
 * usa esos elementos (los que acaba de cargar la pantalla Rally); sin ellos, pide a Rally los de todas las tareas
 * enlazadas. Devuelve cuántas ha movido.
 */
export async function applyRallyStates(items?: RallyItem[]): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const [tasks, types] = await Promise.all([repo.listTasks(), repo.listItemTypes()]);
    let list = items;
    if (!list) {
      const ids = rallyIdsOf(tasks);
      if (!ids.length) return 0;
      list = await rallyApi.lookup(ids);
    }
    rememberRally(list);
    const moves = rallyMoves(tasks, list.filter((it) => !pending.has(it.id)), types);
    if (!moves.length) return 0;
    const label = moves.length === 1
      ? `${moves[0].item.id} movida a ${moves[0].stateName} como en Rally`
      : `${moves.length} tareas movidas como en Rally`;
    applying = true;
    try {
      await repo.batch(label, async () => {
        for (const m of moves) await repo.setState(m.task.id, m.stateId);
      });
    } finally {
      applying = false;
    }
    return moves.length;
  } finally {
    running = false;
  }
}

/**
 * Lleva a Rally los cambios de categoría hechos en el gestor (y al deshacer o rehacer). `notify` recibe el resultado
 * de cada elemento; si no se ha podido mover, volverá a su categoría de Rally en la siguiente pasada.
 */
export async function pushToRally(event: HistoryEvent, notify: (message: string) => void) {
  if (applying) {
    if (event.type === 'push') fromRally.add(event.entry);
    return;
  }
  if (fromRally.has(event.entry)) return;
  const pushes = rallyPushes(event.entry.changes, event.type === 'undo', await repo.listItemTypes());
  await Promise.all(pushes.map(async ({ id, category, taskId, fromStateId }) => {
    const result = await moveInRally(id, category, undefined, notify);
    if (result === 'cancel') {
      await revert(taskId, fromStateId);
      notify(`Movimiento de ${id} cancelado`);
    }
  }));
}

/**
 * Mueve un elemento en Rally (a la categoría o, con `flow`, a esa columna): primero sin escribir para saber si lleva
 * comentario; si lo lleva, pregunta por el analista (cerrar = `cancel`, no se toca Rally), mueve, y publica el
 * comentario. Devuelve el elemento movido, `cancel` o `null` si ha fallado (ya avisado).
 */
async function moveInRally(id: string, category: RallyCategory, flow: string | undefined, notify: (message: string) => void): Promise<RallyItem | 'cancel' | null> {
  pending.add(id);
  try {
    const preview = await rallyApi.move(id, category, { dryRun: true, flow });
    let analyst: RallyRef | null = null;
    let text: string | null = null;
    if (preview.comment) {
      // A Completed, el texto de la plantilla «Owner · Entrega de la guía» (si no, el previsto por el servidor).
      const suggested = category === 'done' && DONE_COMMENT ? DONE_COMMENT : preview.comment;
      const answer = await askAnalyst({ id: preview.id, name: preview.name, text: suggested, owner: preview.owner });
      if (answer === 'cancel') return 'cancel';
      analyst = answer.analyst;
      text = answer.text;
    }
    // Al bloquear, el comentario (sin las personas) va también al motivo de bloqueo de Rally.
    const blockedReason = category === 'blocked' ? (text ?? preview.comment ?? undefined) : undefined;
    const item = await rallyApi.move(id, category, { blockedReason, flow });
    rememberRally([item]);
    if (!item.comment) { notify(`${id} en Rally: ${item.state}`); return item; }
    try {
      // El texto que se haya escrito en la ventana (lápiz) manda sobre el previsto.
      const r = await rallyApi.moveComment(item.id, text ?? item.comment, analyst);
      notify(`${id} en Rally: ${item.state} · comentado${r.owner ? ` para ${r.owner}` : ''}${r.analyst ? ` · analista ${r.analyst}` : ''}`);
      // Entrega (a Completed): «Os mando la convocatoria» → se abre la reunión nueva con las personas mencionadas.
      if (category === 'done') askMeeting({ title: `Entrega de la guía · ${item.id} ${item.name}`, invite: r.people ?? [] });
    } catch (e) {
      notify(`${id} en Rally: ${item.state}, pero no se ha podido comentar: ${(e as Error).message}`);
    }
    return item;
  } catch (e) {
    // Sin Rally conectado no hay nada que avisar.
    if (!/Conecta Rally/.test((e as Error).message)) notify(`No se ha podido mover ${id} en Rally: ${(e as Error).message}`);
    return null;
  } finally {
    pending.delete(id);
  }
}

/**
 * Tablero «Como en Rally»: soltar una tarjeta enlazada en una columna (Need Review, Defined…) la mueve primero en Rally
 * (con la misma ventana de comentario y analista) y después, si cambia de grupo, la tarea del gestor, sin volver a
 * mandarlo a Rally. Cerrar la ventana no cambia nada.
 */
export async function moveToRallyColumn(task: Task, flow: string, category: RallyCategory, notify: (message: string) => void) {
  const id = task.external_id!.replace(/-/g, '').toUpperCase();
  const item = await moveInRally(id, category, flow, notify);
  if (item === 'cancel') { notify(`Movimiento de ${id} cancelado`); return; }
  if (!item) return;
  const types = await repo.listItemTypes();
  const [move] = rallyMoves([task], [item], types);
  if (!move) return;
  applying = true;
  try {
    await repo.batch(`${id} movida a ${item.state}`, () => repo.setState(task.id, move.stateId));
  } finally {
    applying = false;
  }
}

/**
 * TS a Need Review (Tablero «Como en Rally»): ventana con defecto, comentario, analista y motivo del bloqueo, todo
 * obligatorio. Al aceptar, el servidor lo hace a la vez (columna, Blocked con motivo y comentario) y la tarea del gestor
 * pasa a su grupo sin reenviarse. Cerrar no cambia nada.
 */
export async function moveToNeedReview(task: Task, notify: (message: string) => void) {
  const id = task.external_id!.replace(/-/g, '').toUpperCase();
  if (pending.has(id)) return;
  const known = rallyItem(id);
  pending.add(id);
  try {
    const answer = await askNeedReview({ id, name: known?.name ?? task.title, owner: known?.owner ?? null });
    if (answer === 'cancel') { notify(`Movimiento de ${id} cancelado`); return; }
    const r = await rallyApi.needReview({ id, defectId: answer.defect.id, text: answer.text, analyst: answer.analyst, reason: answer.reason });
    rememberRally([r.item]);
    notify(r.commentError
      ? `${id} en Need Review y bloqueada, pero no se ha podido comentar: ${r.commentError}`
      : `${id} en Need Review · bloqueada · comentado${r.owner ? ` para ${r.owner}` : ''} · analista ${r.analyst}`);
    const [move] = rallyMoves([task], [r.item], await repo.listItemTypes());
    if (!move) return;
    applying = true;
    try {
      await repo.batch(`${id} movida a Need Review`, () => repo.setState(task.id, move.stateId));
    } finally {
      applying = false;
    }
  } catch (e) {
    notify(`No se ha podido llevar ${id} a Need Review: ${(e as Error).message}`);
  } finally {
    pending.delete(id);
  }
}

/** Devuelve la tarea a su estado anterior sin mandarlo a Rally (allí no se ha movido). */
async function revert(taskId: string, stateId: string) {
  applying = true;
  try {
    await repo.batch('Movimiento cancelado', () => repo.setState(taskId, stateId));
  } finally {
    applying = false;
  }
}
