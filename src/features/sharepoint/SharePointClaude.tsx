import { useEffect, useMemo, useRef } from 'react';
import { Bot, CheckCircle2, Puzzle, TriangleAlert } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { sync, useSync } from '../../data/sync';
import type { SpRequest } from '../../domain/spClaude';
import type { SharePointFolder } from '../../domain/sharepoint';
import { usePersistentState } from '../../hooks/usePersistentState';
import { extDocs, isOutdated, LATEST_EXTENSION, useExtension } from '../mslist/extension';
import { track } from '../usage/track';
import { describeRequest, handleSpRequest, logSpRequest, useSpLog } from './claudeBridge';

/** «Dejar que Claude lea mis carpetas»: de cada persona y de cada navegador. Apagado por defecto. */
export const useClaudeAccess = () => usePersistentState<boolean>('sharepoint-claude', false);

/** Carpetas guardadas que ve la persona: las suyas y las de los proyectos. */
function useSavedFolders(): SharePointFolder[] {
  const { projects, settings } = useApp();
  return useMemo(() => [...settings.sharepoint_folders, ...projects.flatMap((p) => p.folders ?? [])], [projects, settings.sharepoint_folders]);
}

/**
 * Siempre montado (en `Main`): con el acceso activado y la extensión al día, atiende las peticiones de Claude que llegan
 * por Supabase (tiempo real y, por si se corta, cada 15 s y al volver a la pestaña).
 */
export function SharePointClaudeBridge() {
  const [enabled] = useClaudeAccess();
  const version = useExtension();
  const { user } = useSync();
  const folders = useSavedFolders();
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const ready = enabled && !!user && !!version && !isOutdated(version);

  useEffect(() => {
    if (!ready) return;
    const busy = new Set<string>();
    let stopped = false;
    const run = async (id: string) => {
      if (busy.has(id) || stopped) return;
      busy.add(id);
      try {
        const req = await sync().spTake(id);
        if (!req) return; // la ha cogido otra pestaña o ya no está
        const what = describeRequest(req, foldersRef.current);
        try {
          const result = await handleSpRequest(req, foldersRef.current, extDocs);
          await sync().spAnswer(req.id, result, null);
          logSpRequest({ at: Date.now(), op: req.op, what, error: null });
          track('sharepoint-claude', req.op);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await sync().spAnswer(req.id, null, message).catch(() => {});
          logSpRequest({ at: Date.now(), op: req.op, what, error: message });
        }
      } catch {
        // Sin conexión o sin la migración 018: se reintenta en la siguiente vuelta.
      } finally {
        busy.delete(id);
      }
    };
    const sweep = () => { void sync().spPending().then((list: SpRequest[]) => { for (const r of list) void run(r.id); }).catch(() => {}); };
    const off = sync().onSpRequest((id) => void run(id));
    sweep();
    const timer = setInterval(sweep, 15_000);
    addEventListener('focus', sweep);
    return () => { stopped = true; off(); clearInterval(timer); removeEventListener('focus', sweep); };
  }, [ready]);
  return null;
}

/** Tarjeta de la pantalla SharePoint: activar el acceso de Claude y ver lo último que ha pedido. */
export function ClaudeAccessCard() {
  const [enabled, setEnabled] = useClaudeAccess();
  const version = useExtension();
  const folders = useSavedFolders();
  const log = useSpLog();
  const outdated = !!version && isOutdated(version);
  return (
    <section className="mb-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-[var(--marc)]" />Claude y tus carpetas</h2>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            Con el conector de Marea, Claude puede ver, buscar y leer los documentos de tus {folders.length} carpetas guardadas
            (nunca el resto de SharePoint, y nunca escribe). Lo hace esta pestaña con tu sesión, así que Marea tiene que estar
            abierta en Chrome. El texto de los documentos llega a Claude para responderte; Marea no guarda nada.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-[var(--marc)]" checked={enabled}
            onChange={(e) => { setEnabled(e.target.checked); track('sharepoint-claude', e.target.checked ? 'on' : 'off'); }} />
          Dejar que Claude lea mis carpetas
        </label>
      </div>
      {enabled && (
        <div className="mt-3 text-xs">
          {!version && (
            <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400"><Puzzle className="size-3.5" />
              Hace falta la extensión «Marea · Lista» ({LATEST_EXTENSION} o posterior) en este Chrome.</p>
          )}
          {outdated && (
            <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400"><TriangleAlert className="size-3.5" />
              Tu extensión es la {version}: actualízala a la {LATEST_EXTENSION} (descárgala en Lista → Conectar, sustituye la carpeta y
              recárgala en chrome://extensions).</p>
          )}
          {version && !outdated && (
            <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-3.5" />
              Listo: pídele a Claude, por ejemplo, «busca en mis carpetas de SharePoint la guía de etiquetado».</p>
          )}
          {log.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-zinc-500">
              {log.map((l) => (
                <li key={l.at}>
                  {new Date(l.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · {l.what}
                  {l.error ? <span className="text-amber-700 dark:text-amber-400"> · {l.error}</span> : ' · hecho'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
