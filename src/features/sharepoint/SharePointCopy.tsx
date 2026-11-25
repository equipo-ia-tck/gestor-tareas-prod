import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, ExternalLink, FileText, Folder, History, Loader2, Upload, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { breadcrumbs, fileSize, isSharePointUrl, type SharePointFolder, type SharePointSnapshot } from '../../domain/sharepoint';
import { usePersistentState } from '../../hooks/usePersistentState';
import { track } from '../usage/track';
import { browseFolder, resolveFolder, uploadTo, type UploadResult } from './sharepointStore';

interface LastFolder { siteUrl: string; folder: string; name: string }
interface Place { siteUrl: string; snap: SharePointSnapshot }

const button = 'inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800';
const primary = 'inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';

/**
 * Después de adjuntar en Rally: «¿Lo subes también a SharePoint?». Si sí, se elige la carpeta (la última usada, las
 * guardadas en Marea o un enlace) y se navega por sus subcarpetas con la extensión; «Subir aquí» la sube con la sesión de
 * la persona, igual que la pantalla SharePoint. Va en un portal con `data-popover` para que la ficha de Rally no se cierre.
 */
export function SharePointCopy({ files, onClose }: { files: File[]; onClose: () => void }) {
  const { projects, settings } = useApp();
  const [step, setStep] = useState<'ask' | 'pick' | 'done'>('ask');
  const [last, setLast] = usePersistentState<LastFolder | null>('sp-upload-last', null);
  const [place, setPlace] = useState<Place | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<UploadResult[] | null>(null);

  // Esc cierra solo esta ventana (la ficha de Rally mira `defaultPrevented`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !progress) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, progress]);

  const saved = useMemo(() => [
    ...settings.sharepoint_folders.map((f) => ({ folder: f, group: 'Personales' })),
    ...projects.filter((p) => p.folders?.length).sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .flatMap((p) => (p.folders ?? []).map((f) => ({ folder: f, group: p.name }))),
  ], [projects, settings.sharepoint_folders]);

  const go = async (run: () => Promise<Place>) => {
    setLoading(true);
    setError(null);
    try { setPlace(await run()); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  };
  const openSaved = (f: SharePointFolder) => go(async () => {
    const w = await resolveFolder(f.url);
    return { siteUrl: w.siteUrl, snap: await browseFolder(w.siteUrl, w.folder) };
  });
  const openPath = (siteUrl: string, path: string) => go(async () => ({ siteUrl, snap: await browseFolder(siteUrl, path) }));
  const openLink = (e: FormEvent) => {
    e.preventDefault();
    if (isSharePointUrl(link)) void openSaved({ id: 'link', name: '', url: link.trim() });
    else setError('Pega el enlace de una carpeta de SharePoint (cópialo de la barra de direcciones).');
  };

  const crumbs = place ? breadcrumbs(place.snap.path, place.snap.site) : [];
  const here = crumbs[crumbs.length - 1]?.name ?? place?.snap.path.split('/').filter(Boolean).pop() ?? '';
  const subfolders = place?.snap.entries.filter((e) => e.kind === 'folder') ?? [];
  const docs = place?.snap.entries.filter((e) => e.kind === 'file') ?? [];
  const clash = new Set(docs.map((d) => d.name.toLowerCase()));
  const repeated = files.filter((f) => clash.has(f.name.toLowerCase())).map((f) => f.name);

  const upload = async () => {
    if (!place) return;
    setError(null);
    setProgress({ done: 0, total: files.length });
    try {
      const r = await uploadTo(place.siteUrl, place.snap.path, files, (done, total) => setProgress({ done, total }));
      setResults(r);
      setLast({ siteUrl: place.siteUrl, folder: place.snap.path, name: here });
      track('rally', 'sharepoint-copy', r.filter((x) => !x.error).length);
      setStep('done');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const names = files.length === 1 ? `«${files[0].name}»` : `los ${files.length} archivos`;

  return createPortal(
    <div data-popover className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 dark:bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !progress) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Subir también a SharePoint"
        className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{step === 'done' ? 'Subido a SharePoint' : '¿Lo subes también a SharePoint?'}</h2>
          <button type="button" onClick={onClose} disabled={!!progress} aria-label="Cerrar" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
        </div>

        {step === 'ask' && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Ya está adjunto en Rally. ¿Quieres subir {names} también a una carpeta de SharePoint?</p>
            <ul className="mt-2 space-y-0.5 text-xs text-zinc-500">
              {files.map((f) => <li key={f.name} className="flex items-center gap-1.5"><FileText className="size-3.5" />{f.name} · {fileSize(f.size)}</li>)}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={button} onClick={onClose}>No</button>
              <button type="button" className={primary} onClick={() => { setStep('pick'); if (last) void openPath(last.siteUrl, last.folder); }}>
                <Upload className="size-4" />Sí, elegir carpeta
              </button>
            </div>
          </>
        )}

        {step === 'pick' && (
          <>
            {!place && (
              <div className="space-y-3">
                {last && (
                  <button type="button" className={`${button} w-full justify-start`} disabled={loading} onClick={() => void openPath(last.siteUrl, last.folder)}>
                    <History className="size-4 text-zinc-400" />La última: <b className="truncate">{last.name}</b>
                  </button>
                )}
                {saved.length > 0 && (
                  <div className="max-h-[40vh] space-y-2 overflow-y-auto">
                    {[...new Set(saved.map((s) => s.group))].map((g) => (
                      <div key={g}>
                        <p className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g}</p>
                        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                          {saved.filter((s) => s.group === g).map(({ folder }) => (
                            <li key={folder.id}>
                              <button type="button" disabled={loading} onClick={() => void openSaved(folder)}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                                <Folder className="size-4 shrink-0 text-amber-500" /><span className="truncate">{folder.name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                <form onSubmit={openLink} className="flex gap-2">
                  <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="…o pega el enlace de una carpeta de SharePoint"
                    className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                  <button type="submit" className={button} disabled={loading || !link.trim()}>Abrir</button>
                </form>
              </div>
            )}

            {place && (
              <div>
                <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm" aria-label="Carpetas">
                  <Folder className="size-4 text-amber-500" />
                  {crumbs.map((c, i) => (
                    <span key={c.path} className="inline-flex items-center gap-1">
                      {i > 0 && <ChevronRight className="size-3.5 text-zinc-400" />}
                      {i === crumbs.length - 1
                        ? <span className="font-semibold">{c.name}</span>
                        : <button type="button" disabled={loading} onClick={() => void openPath(place.siteUrl, c.path)} className="text-indigo-700 hover:underline dark:text-indigo-300">{c.name}</button>}
                    </span>
                  ))}
                  {loading && <Loader2 className="ml-1 size-4 animate-spin text-zinc-400" />}
                </nav>
                <ul className={`max-h-[40vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800 ${loading ? 'opacity-60' : ''}`}>
                  {subfolders.map((e) => (
                    <li key={e.path}>
                      <button type="button" disabled={loading} onClick={() => void openPath(place.siteUrl, e.path)} title="Entrar en la carpeta"
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                        <Folder className="size-4 shrink-0 text-amber-500" /><span className="min-w-0 flex-1 truncate">{e.name}</span>
                        <ChevronRight className="size-3.5 text-zinc-400" />
                      </button>
                    </li>
                  ))}
                  {docs.map((e) => (
                    <li key={e.path} className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-400">
                      <FileText className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{e.name}</span>
                    </li>
                  ))}
                  {!place.snap.entries.length && <li className="px-3 py-2 text-sm text-zinc-400">La carpeta está vacía.</li>}
                </ul>
                <button type="button" onClick={() => setPlace(null)} className="mt-2 text-xs text-zinc-500 hover:underline">← Elegir otra carpeta</button>
                {repeated.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Ya hay {repeated.length === 1 ? `un archivo «${repeated[0]}»` : `archivos con esos nombres (${repeated.join(', ')})`} aquí: no se sustituye y no se subirá.
                  </p>
                )}
              </div>
            )}

            {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              {progress && <span className="mr-auto flex items-center gap-1.5 text-xs text-zinc-500"><Loader2 className="size-3.5 animate-spin" />Subiendo {Math.min(progress.done + 1, progress.total)} de {progress.total}…</span>}
              <button type="button" className={button} onClick={onClose} disabled={!!progress}>Cancelar</button>
              <button type="button" className={primary} disabled={!place || loading || !!progress} onClick={() => void upload()}>
                <Upload className="size-4" />{place ? `Subir a «${here}»` : 'Elige una carpeta'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && results && place && (
          <>
            <p className="text-sm">{results.filter((r) => !r.error).length} de {results.length} subidos a «{here}».</p>
            {results.map((r) => (
              <p key={r.name} className={`mt-1 flex items-center gap-1.5 text-xs ${r.error ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'}`}>
                {r.error ? <X className="size-3.5" /> : <Check className="size-3.5 text-emerald-600" />}{r.name}{r.error ? `: ${r.error}` : ''}
              </p>
            ))}
            <div className="mt-4 flex justify-end gap-2">
              <a href={place.snap.url} target="_blank" rel="noopener noreferrer" className={button}><ExternalLink className="size-4" />Abrir en SharePoint</a>
              <button type="button" className={primary} onClick={onClose}>Hecho</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
