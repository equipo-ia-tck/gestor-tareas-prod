import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, FileText, Folder, FolderSync, Loader2, RefreshCw, Search } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { inputClass } from '../../components/ui/styles';
import { formatDay } from '../../domain/dates';
import { childrenOf, countIn, nameOf, parentOf, searchSynced, type SyncedRoot } from '../../domain/sharepointSync';
import { track } from '../usage/track';
import { useSyncedSharePoint } from './sharepointCloud';
import { useSharePointSnapshot } from './sharepointStore';

const card = 'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900';

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? 'ahora mismo' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};

/**
 * Carpetas sincronizadas con Power Automate: se navegan dentro de Marea sin marcador ni pestaña de SharePoint. Cada
 * archivo se abre en SharePoint (con la cuenta de CaixaBank). Lo que se ve es lo que subió el Mac la última vez.
 */
export function SyncedFolders() {
  const { synced, error, loading, reload } = useSyncedSharePoint();
  const { syncedTarget } = useSharePointSnapshot();
  const { today } = useApp();
  const roots = synced?.roots ?? [];
  const [rootIdx, setRootIdx] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const root: SyncedRoot | undefined = roots[Math.min(rootIdx, roots.length - 1)];
  const here = path ?? root?.root ?? '';

  // Al pulsar una carpeta guardada que está sincronizada, se abre aquí.
  useEffect(() => {
    if (!syncedTarget) return;
    const i = roots.findIndex((r) => r.site === syncedTarget.site && (syncedTarget.path === r.root || syncedTarget.path.startsWith(r.root + '/')));
    if (i >= 0) { setRootIdx(i); setPath(syncedTarget.path); setQ(''); }
  }, [syncedTarget, roots]);

  const list = useMemo(() => (root ? childrenOf(root, here) : []), [root, here]);
  const found = useMemo(() => (q.trim().length >= 2 ? searchSynced(roots, q) : null), [roots, q]);
  const crumbs = useMemo(() => {
    if (!root) return [];
    const base = root.root;
    const rest = here === base ? [] : here.slice(base.length + 1).split('/');
    return [{ name: nameOf(base) || base || 'Carpeta', path: base }, ...rest.map((n, i) => ({ name: n, path: `${base}/${rest.slice(0, i + 1).join('/')}` }))];
  }, [root, here]);
  const go = (p: string) => { setPath(p); setQ(''); track('sharepoint', 'synced-navigate'); };

  return (
    <section id="sp-synced" className={card}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <FolderSync className="size-4 text-[var(--marc)]" />Carpetas sincronizadas
        <span className="ml-auto flex items-center gap-2 text-xs font-normal text-zinc-500">
          {synced && <>actualizado {ago(synced.fileAt ?? synced.uploadedAt)}</>}
          <button type="button" onClick={() => void reload()} disabled={loading} title="Volver a cargar"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />Actualizar
          </button>
        </span>
      </h2>
      <p className="mb-3 text-xs text-zinc-500">Las trae tu flujo de Power Automate cada pocos minutos: sin marcador ni pestaña de SharePoint. Los archivos se abren en SharePoint con tu cuenta.</p>
      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {synced === undefined && !error && <p className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />Cargando…</p>}
      {synced === null && <FlowSetup />}
      {synced && roots.length === 0 && <p className="text-sm text-zinc-500">El último archivo no traía carpetas. Revisa el flujo (la lista «Carpetas»).</p>}
      {root && (
        <>
          {roots.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {roots.map((r, i) => (
                <button key={`${r.site}|${r.root}`} type="button" onClick={() => { setRootIdx(i); setPath(null); setQ(''); }}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${i === rootIdx ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800'}`}>
                  {nameOf(r.root) || r.root}
                </button>
              ))}
            </div>
          )}
          <div className={`mb-2 flex items-center gap-1.5 ${inputClass}`}>
            <Search className="size-4 text-zinc-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en todas las carpetas sincronizadas…" aria-label="Buscar en SharePoint"
              className="w-full bg-transparent outline-none" />
          </div>
          {found ? (
            <ul className="max-h-[65vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {found.map(({ root: r, item }) => (
                <li key={`${r.site}|${item.p}`}>
                  {item.f
                    ? <button type="button" onClick={() => { setRootIdx(roots.indexOf(r)); go(item.p); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                        <Folder className="size-4 shrink-0 text-amber-500" /><span className="min-w-0 flex-1 truncate">{item.n}</span>
                        <span className="truncate text-xs text-zinc-400">{parentOf(item.p)}</span></button>
                    : <a href={item.u} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                        <FileText className="size-4 shrink-0 text-zinc-400" /><span className="min-w-0 flex-1 truncate">{item.n}</span>
                        <span className="truncate text-xs text-zinc-400">{parentOf(item.p)}</span></a>}
                </li>
              ))}
              {!found.length && <li className="px-3 py-3 text-sm text-zinc-400">Nada con ese nombre en lo sincronizado.</li>}
            </ul>
          ) : (
            <>
              <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm" aria-label="Carpetas">
                <Folder className="size-4 text-amber-500" />
                {crumbs.map((c, i) => (
                  <span key={c.path} className="inline-flex items-center gap-1">
                    {i > 0 && <ChevronRight className="size-3.5 text-zinc-400" />}
                    {i === crumbs.length - 1 ? <span className="font-semibold">{c.name}</span>
                      : <button type="button" onClick={() => go(c.path)} className="text-indigo-700 hover:underline dark:text-indigo-300">{c.name}</button>}
                  </span>
                ))}
              </nav>
              <ul className="max-h-[65vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {list.map((item) => {
                  const body = (
                    <>
                      {item.f ? <Folder className="size-4 shrink-0 text-amber-500" /> : <FileText className="size-4 shrink-0 text-zinc-400" />}
                      <span className="min-w-0 flex-1 truncate">{item.n}</span>
                      {item.f && <span className="shrink-0 text-xs text-zinc-400">{countIn(root, item.p)} elementos</span>}
                      <span className="hidden w-24 shrink-0 text-right text-xs text-zinc-400 sm:inline">{item.m ? formatDay(item.m.slice(0, 10), today) : ''}</span>
                    </>
                  );
                  const row = 'flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60';
                  return (
                    <li key={item.p} className="group flex items-center">
                      {item.f
                        ? <button type="button" onClick={() => go(item.p)} className={row} title="Entrar en la carpeta">{body}</button>
                        : <a href={item.u} target="_blank" rel="noopener noreferrer" onClick={() => track('sharepoint', 'synced-open')} className={row} title="Abrir en SharePoint">{body}</a>}
                      <a href={item.u} target="_blank" rel="noopener noreferrer" title="Abrir en SharePoint" aria-label={`Abrir ${item.n} en SharePoint`}
                        className="mr-1 shrink-0 rounded p-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
                        <ExternalLink className="size-3.5" /></a>
                    </li>
                  );
                })}
                {!list.length && <li className="px-3 py-3 text-sm text-zinc-400">Esta carpeta está vacía (o el flujo no la ha traído).</li>}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Sin nada sincronizado todavía: qué hay que montar (los pasos detallados están en docs/sharepoint-power-automate.md). */
function FlowSetup() {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      <p className="mb-2 font-semibold">Aún no hay carpetas sincronizadas. Para traerlas sin marcador:</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Crea en Power Automate el flujo «Marea · SharePoint» (programado): lee las carpetas que elijas y escribe <code>Gestor/sharepoint.json</code> en tu OneDrive.</li>
        <li>Deja en marcha en el Mac el programa de subida (el mismo del calendario, con tu clave de Ajustes → Calendario de Outlook). Si ya lo tienes, no hace falta nada más: sube también este archivo.</li>
        <li>En unos minutos, las carpetas aparecen aquí.</li>
      </ol>
    </div>
  );
}
