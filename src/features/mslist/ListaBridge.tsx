import { useEffect } from 'react';
import { useApp } from '../../app/AppContext';
import { useSync } from '../../data/sync';
import { LIST_TYPE_ID, listItemType, statusValues } from '../../domain/msList';
import { useToast } from '../../components/Toast';
import { repo } from '../../data/services';
import { isSharePointOrigin, parseSnapshot, type MsListResult } from '../../domain/msListParse';
import { track } from '../usage/track';
import { extensionVersion, extSync, useExtension } from './extension';
import { getListaState, isConnected, loadListaConfig, markContact, outgoing, useLista, receiveSnapshot, setExtStatus, subscribeLista, wantsList } from './listaStore';
import { afterCreated, applyListStates, pushToList } from './listaStates';

/** Resultados que llegan de SharePoint (por el marcador o la extensión), validados. */
function cleanResults(raw: unknown): MsListResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is MsListResult => !!r && typeof r === 'object' && typeof (r as MsListResult).key === 'string')
    .map((r) => ({
      key: r.key.slice(0, 100),
      ok: r.ok === true,
      error: typeof r.error === 'string' ? r.error.slice(0, 300) : undefined,
      id: typeof r.id === 'string' && /^\d+$/.test(r.id) ? r.id : undefined,
      skipped: Array.isArray(r.skipped) ? r.skipped.filter((x): x is string => typeof x === 'string').slice(0, 30) : undefined,
    }));
}

/**
 * Sin interfaz, en todas las pantallas. Contesta al marcador «Marea · Lista» (solo desde páginas de SharePoint Online),
 * que pregunta cada 4 s mientras su pestaña siga abierta: le da los cambios pendientes (de esta pestaña o de cualquier
 * otra de Marea, por localStorage) y si quiere la lista entera, y guarda la lista que manda. Además lleva a la lista (como cambio pendiente) los
 * movimientos de las tareas enlazadas y, al arrancar, pone las tareas enlazadas en el estado de su elemento.
 */
export function ListaBridge() {
  const toast = useToast();
  const extension = useExtension();
  useExtensionSync(!!extension, toast);
  useListType();
  useEffect(() => {
    let first = true;
    /** La pestaña de SharePoint conectada (la última que ha dicho «hola» a esta pestaña). */
    let peer: { win: Window; origin: string } | null = null;
    let sent = '';
    const offer = (target: { win: Window; origin: string }) => {
      const s = getListaState();
      const wantList = wantsList(s);
      // Los que fallaron no se reintentan cada 4 s: solo con la relectura de cada 2 minutos.
      const changes = outgoing(s, wantList);
      sent = JSON.stringify(changes);
      target.win.postMessage({ type: 'marea-lista:ready', changes, wantList }, target.origin);
    };
    // Un cambio nuevo (en esta pestaña o en otra de Marea) se manda al momento, sin esperar a la próxima pregunta: en
    // una pestaña que no está a la vista, Chrome espacia los temporizadores hasta un minuto.
    const stopStore = subscribeLista(() => {
      const s = getListaState();
      const fresh = outgoing(s);
      if (!peer || peer.win.closed || !isConnected(s) || !fresh.length || JSON.stringify(fresh) === sent) return;
      try { offer(peer); } catch { peer = null; }
    });
    const onMessage = (e: MessageEvent) => {
      if (!isSharePointOrigin(e.origin)) return;
      const data = e.data as Record<string, unknown> | null;
      const source = e.source as Window | null;
      if (!data || typeof data !== 'object' || !source) return;
      if (data.type === 'marea-lista:hello') {
        peer = { win: source, origin: e.origin };
        markContact();
        offer(peer);
      } else if (data.type === 'marea-lista:data') {
        const snapshot = parseSnapshot(data.list);
        if (!snapshot) { toast('Lo que ha llegado del marcador no parece una lista.'); return; }
        const results = cleanResults(data.results);
        void afterCreated(receiveSnapshot(snapshot, results), toast);
        const bad = results.filter((r) => !r.ok).length;
        track('lista-sync', bad ? 'errors' : 'ok', snapshot.items.length);
        // Solo se avisa la primera vez y cuando se aplican cambios (la lista se relee sola cada 2 minutos).
        if (first || results.length) {
          toast(results.length
            ? `Lista: ${results.length - bad} ${results.length - bad === 1 ? 'cambio aplicado' : 'cambios aplicados'} en SharePoint${bad ? `, ${bad} con error` : ''}`
            : `${snapshot.title}: ${snapshot.items.length} elementos. Deja abierta la pestaña de SharePoint y los cambios se aplican solos.`);
        }
        first = false;
        void applyListStates().catch(() => {});
      } else if (data.type === 'marea-lista:error' && typeof data.message === 'string') {
        toast(`La lista: ${data.message.slice(0, 200)}`);
      }
    };
    window.addEventListener('message', onMessage);
    const stopHistory = repo.onHistory((ev) => { void pushToList(ev, (message) => toast(message)); });
    void applyListStates().catch(() => {});
    return () => { window.removeEventListener('message', onMessage); stopHistory(); stopStore(); };
  }, [toast]);
  return null;
}

/** Cada cuánto mira la extensión si hay algo que hacer (los cambios nuevos van al momento). */
const EXT_EVERY_MS = 20_000;

/**
 * Con la extensión instalada y la dirección de la lista: aplica los cambios pendientes en cuanto aparecen y relee la
 * lista cada 2 minutos, sin tener SharePoint abierto. Solo lo hace una pestaña de Marea a la vez (Web Locks); las demás
 * se enteran por localStorage.
 */
function useExtensionSync(enabled: boolean, toast: (message: string) => void) {
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let again = false;
    let lastError: string | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const work = async () => {
      const s = getListaState();
      if (!s.listUrl || !extensionVersion()) return;
      const wantList = wantsList(s) || !s.snapshot || s.snapshot.url !== s.listUrl;
      // Los que fallaron se reintentan solo con la relectura.
      const changes = outgoing(s, wantList);
      if (!changes.length && !wantList) return;
      const r = await extSync(s.listUrl, changes, wantList);
      const snapshot = r.error ? null : parseSnapshot(r.list);
      if (r.error || (r.list && !snapshot)) {
        const message = r.error ?? 'La extensión ha devuelto algo que no parece una lista.';
        setExtStatus(message);
        if (message !== lastError) toast(`Lista: ${message}`);
        lastError = message;
        return;
      }
      lastError = null;
      setExtStatus(null);
      const results = cleanResults(r.results);
      if (snapshot) void afterCreated(receiveSnapshot(snapshot, results), toast);
      if (results.length) {
        const bad = results.filter((x) => !x.ok).length;
        toast(`Lista: ${results.length - bad} ${results.length - bad === 1 ? 'cambio aplicado' : 'cambios aplicados'} en SharePoint${bad ? `, ${bad} con error` : ''}`);
        track('lista-sync', bad ? 'extension-errors' : 'extension', results.length);
      }
      void applyListStates().catch(() => {});
    };

    const run = () => {
      if (running) { again = true; return; }
      running = true;
      const go = async () => {
        try {
          do { again = false; await work(); } while (again);
        } finally {
          running = false;
        }
      };
      // Una sola pestaña sincroniza; si otra lo está haciendo, esta no.
      if (navigator.locks) void navigator.locks.request('marea-lista-sync', { ifAvailable: true }, async (lock) => { if (lock) await go(); else running = false; });
      else void go();
    };

    const timer = setInterval(run, EXT_EVERY_MS);
    let sent = JSON.stringify(outgoing());
    let lastUrl = getListaState().listUrl;
    const stop = subscribeLista(() => {
      const s = getListaState();
      const now = JSON.stringify(outgoing(s));
      // Un cambio nuevo (en esta pestaña o en otra) o una lista nueva: enseguida.
      if (now === sent && s.listUrl === lastUrl) return;
      sent = now;
      lastUrl = s.listUrl;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 400);
    });
    run();
    return () => { clearInterval(timer); stop(); if (debounce) clearTimeout(debounce); };
  }, [enabled, toast]);
}

/**
 * Tipo «Lista» del Tablero con los estados de la columna de estado de la lista (Backlog, En curso, Dependencia…): lo
 * crea y lo mantiene la sesión de un administrador (los tipos son comunes al equipo); en cualquier sesión, las tareas de
 * la lista que siguen como Tarea pasan a ese tipo.
 */
function useListType() {
  const { itemTypes } = useApp();
  const { isAdmin } = useSync();
  const lista = useLista();
  const config = loadListaConfig();
  const field = lista.snapshot && config.statusColumn ? lista.snapshot.fields.find((f) => f.label === config.statusColumn) : undefined;
  const values = lista.snapshot && config.statusColumn
    ? field?.choices.length ? field.choices : statusValues(lista.snapshot.items, config.statusColumn)
    : [];
  const key = JSON.stringify([values, config]);
  const hasType = itemTypes.some((t) => t.id === LIST_TYPE_ID);
  useEffect(() => {
    if (!itemTypes.length || (!values.length && !hasType)) return;
    const order = Math.max(0, ...itemTypes.map((t) => t.order)) + 1;
    void repo.ensureListType(isAdmin && values.length ? listItemType(values, config, order) : null).catch(() => {});
  }, [key, isAdmin, hasType, itemTypes.length]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` resume lista y configuración
}
