import { repo } from '../../data/services';
import type { HistoryEntry, HistoryEvent } from '../../data/repository';
import { LIST_CATEGORIES, listMoves, listPushes, statusValues, valueForCategory } from '../../domain/msList';
import { currentItems, extensionOk, getListaState, isConnected, loadListaConfig, queueChange } from './listaStore';

let running = false;
/** Mientras se aplican cambios que vienen de la lista, el historial no los vuelve a mandar. */
let applying = false;
/** Entradas que vinieron de la lista: deshacerlas solo cambia el gestor. */
const fromList = new WeakSet<HistoryEntry>();

/**
 * Pone cada tarea enlazada (`LS-<id>`) en la categoría que tiene su elemento en la lista (la lista manda, con los
 * cambios pendientes ya puestos), en un solo «Deshacer». Devuelve cuántas mueve.
 */
export async function applyListStates(): Promise<number> {
  if (running) return 0;
  const config = loadListaConfig();
  if (!config.statusColumn || !getListaState().snapshot) return 0;
  running = true;
  try {
    const [tasks, types] = await Promise.all([repo.listTasks(), repo.listItemTypes()]);
    const moves = listMoves(tasks, currentItems(), config, types);
    if (!moves.length) return 0;
    applying = true;
    try {
      await repo.batch(moves.length === 1 ? `Movida a ${moves[0].stateName} como en la lista` : `${moves.length} tareas movidas como en la lista`, async () => {
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
 * Al mover aquí una tarea enlazada, apunta el valor nuevo de la columna de estado; se aplica en la lista la próxima vez
 * que se pulse el marcador.
 */
export async function pushToList(event: HistoryEvent, notify: (message: string) => void) {
  if (applying) {
    if (event.type === 'push') fromList.add(event.entry);
    return;
  }
  if (fromList.has(event.entry)) return;
  const config = loadListaConfig();
  if (!config.statusColumn || !getListaState().snapshot) return;
  const pushes = listPushes(event.entry.changes, event.type === 'undo', await repo.listItemTypes());
  if (!pushes.length) return;
  const values = statusValues(getListaState().snapshot!.items, config.statusColumn);
  for (const { id, category } of pushes) {
    const value = valueForCategory(category, values, config);
    const label = LIST_CATEGORIES.find((c) => c.category === (category === 'accepted' ? 'done' : category))?.label ?? category;
    if (!value) {
      notify(`El elemento ${id} no se cambiará en la lista: ningún valor de «${config.statusColumn}» corresponde a ${label}.`);
      continue;
    }
    queueChange(id, config.statusColumn, value);
    notify(isConnected() || extensionOk()
      ? `Elemento ${id}: «${value}» se está poniendo en la lista`
      : `Elemento ${id}: «${value}» se pondrá en la lista en cuanto haya conexión (extensión o marcador «Marea · Lista»)`);
  }
}
