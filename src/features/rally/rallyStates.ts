import { repo } from '../../data/services';
import type { HistoryEntry, HistoryEvent } from '../../data/repository';
import { rallyIdsOf, rallyMoves, rallyPushes, type RallyCategory, type RallyItem } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { rallyApi } from './rallyApi';
import { askComment, type CommentAnswer } from './AnalystPrompt';
import { commentShape } from '../../domain/rallyComments';
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

/** El cambio lo ha traído Rally (no lo ha hecho la persona): la analítica lo cuenta aparte. */
export const cameFromRally = (entry: HistoryEntry) => applying || fromRally.has(entry);

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
 * comentario; si lo lleva, abre la ventana del comentario (Para, texto y CC; cerrar = `cancel`, no se toca Rally; si es
 * opcional, «Mover sin comentar»), mueve y publica el comentario. Devuelve el elemento movido, `cancel` o `null` si ha fallado (ya avisado).
 */
async function moveInRally(id: string, category: RallyCategory, flow: string | undefined, notify: (message: string) => void): Promise<RallyItem | 'cancel' | null> {
  pending.add(id);
  try {
    const preview = await rallyApi.move(id, category, { dryRun: true, flow });
    let answer: Exclude<CommentAnswer, 'cancel'> | null = null;
    const kind = preview.kind;
    const step = preview.commentStep ?? null;
    if (preview.comment) {
      // US a Completed: la plantilla «Owner · Entrega de la guía» (si no, el texto previsto por el servidor).
      const suggested = step === 'done' && kind !== 'TS' && DONE_COMMENT ? DONE_COMMENT : preview.comment;
      const shape = step ? commentShape(kind, step) : undefined;
      const a = await askComment({ id: preview.id, name: preview.name, text: suggested, owner: preview.owner, shape,
        cc: shape?.ccEveryone ? preview.mentioned ?? [] : [], skipLabel: 'Mover sin comentar' });
      if (a === 'cancel') return 'cancel';
      answer = a;
    }
    const comment = answer && answer !== 'skip' ? answer : null;
    // Al bloquear, el comentario (sin las personas) va también al motivo de bloqueo de Rally.
    const blockedReason = category === 'blocked' ? (comment?.text ?? preview.comment ?? undefined) : undefined;
    const item = await rallyApi.move(id, category, { blockedReason, flow });
    rememberRally([item]);
    if (!item.comment || answer === 'skip') { notify(`${id} en Rally: ${item.state}${answer === 'skip' ? ' · sin comentario' : ''}`); return item; }
    try {
      // El texto que se haya escrito en la ventana (lápiz) manda sobre el previsto.
      const r = await rallyApi.moveComment(item.id, comment?.text ?? item.comment,
        comment ? { owner: comment.owner, noOwner: comment.noOwner, cc: comment.cc } : { owner: null, noOwner: false, cc: [] });
      notify(`${id} en Rally: ${item.state} · comentado${r.owner ? ` para ${r.owner}` : ''}${r.cc.length ? ` · CC ${r.cc.join(', ')}` : ''}`);
      // Entrega de una US (a Completed): se abre la reunión nueva con las personas mencionadas. Los TS no tienen reunión.
      if (category === 'done' && item.kind !== 'TS') askMeeting({ title: `Entrega de la guía · ${item.id} ${item.name}`, invite: r.people ?? [] });
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

/** Tarea del gestor enlazada a un ID de Rally (la primera que no esté borrada), para moverla de grupo con Rally. */
async function linkedTask(id: string): Promise<Task | undefined> {
  const key = id.replace(/-/g, '').toUpperCase();
  return (await repo.listTasks()).find((t) => t.external_id?.replace(/-/g, '').toUpperCase() === key);
}

/** Pasa la tarea del gestor al grupo que tiene `item` en Rally, sin volver a mandarlo a Rally. */
async function followRally(task: Task | undefined, item: RallyItem, label: string) {
  if (!task) return;
  const [move] = rallyMoves([task], [item], await repo.listItemTypes());
  if (!move) return;
  applying = true;
  try {
    await repo.batch(label, () => repo.setState(task.id, move.stateId));
  } finally {
    applying = false;
  }
}

/**
 * Tablero «Como en Rally»: soltar una tarjeta enlazada en una columna (Need Review, Defined…) la mueve primero en Rally
 * (con la misma ventana de comentario) y después, si cambia de grupo, la tarea del gestor, sin volver a mandarlo a
 * Rally. Cerrar la ventana no cambia nada.
 */
export async function moveToRallyColumn(task: Task, flow: string, category: RallyCategory, notify: (message: string) => void) {
  await moveRallyItem(task.external_id!, flow, category, notify, task);
}

/**
 * Mueve un elemento de Rally a una columna (o, sin `flow`, a una categoría) desde cualquier sitio: el Tablero o la
 * ficha de Rally. Abre la misma ventana de comentario y, si hay tarea enlazada, la cambia de grupo. Need Review solo
 * vale para los TS (con su ventana de defecto). Devuelve el elemento movido, `cancel` o `null`.
 */
export async function moveRallyItem(rawId: string, flow: string | undefined, category: RallyCategory, notify: (message: string) => void,
  task?: Task, name?: string): Promise<RallyItem | 'cancel' | null> {
  const id = rawId.replace(/-/g, '').toUpperCase();
  if (flow && flow.toLowerCase().replace(/[^a-z]/g, '') === 'needreview') {
    if (!id.startsWith('TS')) { notify('En Rally, solo los TS pueden ir a Need Review'); return null; }
    return moveToNeedReview(task ?? (await linkedTask(id)), notify, id, name);
  }
  const item = await moveInRally(id, category, flow, notify);
  if (item === 'cancel') { notify(`Movimiento de ${id} cancelado`); return item; }
  if (!item) return null;
  await followRally(task ?? (await linkedTask(id)), item, `${id} movida a ${item.state}`);
  return item;
}

/**
 * TS a Need Review (Tablero «Como en Rally» o ficha): ventana con defecto, comentario, PO IT, CC y motivo del bloqueo.
 * Al aceptar, el servidor lo hace a la vez (columna, Blocked con motivo y comentario) y la tarea del gestor, si la hay,
 * pasa a su grupo sin reenviarse. Cerrar no cambia nada.
 */
export async function moveToNeedReview(task: Task | undefined, notify: (message: string) => void, rawId?: string, name?: string): Promise<RallyItem | 'cancel' | null> {
  const id = (rawId ?? task?.external_id ?? '').replace(/-/g, '').toUpperCase();
  if (!id || pending.has(id)) return null;
  const known = rallyItem(id);
  pending.add(id);
  try {
    const answer = await askNeedReview({ id, name: known?.name ?? name ?? task?.title ?? id, owner: known?.owner ?? null });
    if (answer === 'cancel') { notify(`Movimiento de ${id} cancelado`); return 'cancel'; }
    const r = await rallyApi.needReview({ id, defectId: answer.defect.id, text: answer.text, reason: answer.reason, owner: answer.owner, noOwner: answer.noOwner, cc: answer.cc });
    rememberRally([r.item]);
    notify(r.commentError
      ? `${id} en Need Review y bloqueada, pero no se ha podido comentar: ${r.commentError}`
      : `${id} en Need Review · bloqueada · comentado${r.owner ? ` para ${r.owner}` : ''}${r.cc.length ? ` · CC ${r.cc.join(', ')}` : ''}`);
    await followRally(task, r.item, `${id} movida a Need Review`);
    return r.item;
  } catch (e) {
    notify(`No se ha podido llevar ${id} a Need Review: ${(e as Error).message}`);
    return null;
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
