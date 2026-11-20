import { useEffect } from 'react';
import { useToast } from '../../components/Toast';
import { repo } from '../../data/services';
import { isSharePointOrigin, parseSnapshot, type MsListResult } from '../../domain/msListParse';
import { track } from '../usage/track';
import { getListaState, receiveSnapshot } from './listaStore';
import { applyListStates, pushToList } from './listaStates';

/**
 * Sin interfaz, en todas las pantallas. Contesta al marcador «Marea · Lista» (solo desde páginas de SharePoint Online):
 * le da los cambios pendientes y guarda la lista que manda. Además lleva a la lista (como cambio pendiente) los
 * movimientos de las tareas enlazadas y, al arrancar, pone las tareas enlazadas en el estado de su elemento.
 */
export function ListaBridge() {
  const toast = useToast();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isSharePointOrigin(e.origin)) return;
      const data = e.data as Record<string, unknown> | null;
      const source = e.source as Window | null;
      if (!data || typeof data !== 'object' || !source) return;
      if (data.type === 'marea-lista:hello') {
        source.postMessage({ type: 'marea-lista:ready', changes: getListaState().pending }, e.origin);
      } else if (data.type === 'marea-lista:data') {
        const snapshot = parseSnapshot(data.list);
        if (!snapshot) { toast('Lo que ha llegado del marcador no parece una lista.'); return; }
        const results: MsListResult[] = Array.isArray(data.results)
          ? data.results.filter((r): r is MsListResult => !!r && typeof r === 'object' && typeof (r as MsListResult).key === 'string')
            .map((r) => ({ key: r.key, ok: r.ok === true, error: typeof r.error === 'string' ? r.error.slice(0, 300) : undefined }))
          : [];
        receiveSnapshot(snapshot, results);
        const bad = results.filter((r) => !r.ok).length;
        track('lista-sync', bad ? 'errors' : 'ok', snapshot.items.length);
        toast(`${snapshot.title}: ${snapshot.items.length} elementos`
          + (results.length ? ` · ${results.length - bad} cambios aplicados${bad ? `, ${bad} con error` : ''}` : ''));
        void applyListStates().catch(() => {});
      } else if (data.type === 'marea-lista:error' && typeof data.message === 'string') {
        toast(`La lista: ${data.message.slice(0, 200)}`);
      }
    };
    window.addEventListener('message', onMessage);
    const stopHistory = repo.onHistory((ev) => { void pushToList(ev, (message) => toast(message)); });
    void applyListStates().catch(() => {});
    return () => { window.removeEventListener('message', onMessage); stopHistory(); };
  }, [toast]);
  return null;
}
