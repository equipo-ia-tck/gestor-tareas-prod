import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bookmark, Check, ChevronRight, Copy, ExternalLink, FileText, Folder, FolderPlus, Loader2, Pencil, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { ViewHeader } from '../views/ViewHeader';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { breadcrumbs, fileSize, isSharePointOrigin, isSharePointUrl, MAX_PREVIEW_BYTES, previewType, type SharePointEntry, type SharePointFolder } from '../../domain/sharepoint';
import { formatDay } from '../../domain/dates';
import { fold } from '../../domain/text';
import { track } from '../usage/track';
import { bookmarkletCode, bookmarkletHref } from './bookmarklet';
import { foldersOf, newFolder, saveFolders } from './folders';
import { handleBridgeMessage, loadFile, openFolder, setSnapshot, useSharePointSnapshot } from './sharepointStore';

const card = 'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900';
const title = 'mb-3 flex items-center gap-2 text-sm font-semibold';

/**
 * Pantalla SharePoint (`#/sharepoint`): accesos a las carpetas del SharePoint de CaixaBank (se abren con la cuenta de
 * proveedor externo; Marea solo guarda nombre y enlace) y, con el marcador, lo que hay dentro de una carpeta, que solo se
 * ve en esta pestaña.
 */
export function SharePointView() {
  useBookmarkletBridge();
  return (
    <>
      <ViewHeader title="SharePoint" subtitle="Las carpetas de CaixaBank con las que trabajas, a un clic. Se abren con tu cuenta de proveedor externo." />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <span>Marea solo guarda el nombre y el enlace de cada carpeta. Los documentos se quedan en SharePoint y se abren con tus
          permisos de CaixaBank. Lo que veas con el marcador no se guarda en ningún sitio: al cerrar esta pestaña desaparece.</span>
      </p>
      <div className="space-y-4">
        <FolderList />
        <FolderContents />
      </div>
    </>
  );
}

/** Contesta al marcador (solo a páginas https de *.sharepoint.com) y recibe lo que manda (`handleBridgeMessage`). */
function useBookmarkletBridge() {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const before = e.data && typeof e.data === 'object' ? (e.data as { type?: unknown }).type : null;
      handleBridgeMessage(e);
      if (before === 'marea-sp:folder' && isSharePointOrigin(e.origin)) track('sharepoint', 'snapshot');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}

// ───────────────────────────── Accesos ─────────────────────────────

function FolderList() {
  const { projects, settings } = useApp();
  const groups = useMemo(() => [
    { projectId: null as string | null, name: 'Personales', color: null as string | null, folders: settings.sharepoint_folders },
    ...projects.filter((p) => p.folders?.length).sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map((p) => ({ projectId: p.id as string | null, name: p.name, color: p.color as string | null, folders: p.folders ?? [] })),
  ], [projects, settings.sharepoint_folders]);
  const total = groups.reduce((n, g) => n + g.folders.length, 0);

  return (
    <section className={card}>
      <h2 className={title}><Folder className="size-4 text-[var(--marc)]" />Mis carpetas · {total}</h2>
      <AddFolder />
      {total === 0 && <p className="mt-3 text-sm text-zinc-500">Aún no hay carpetas. Pega arriba el enlace de una carpeta de SharePoint (cópialo de la barra de direcciones).</p>}
      <div className="mt-3 space-y-3">
        {groups.filter((g) => g.folders.length).map((g) => (
          <div key={g.projectId ?? 'personal'}>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
              {g.color && <span className="size-2 rounded-full" style={{ background: g.color }} />}{g.name}
            </p>
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {g.folders.map((f) => <FolderRow key={f.id} folder={f} projectId={g.projectId} />)}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Pegar un enlace de SharePoint y elegir si es personal o de un proyecto. */
export function AddFolder({ projectId: fixedProject, compact = false }: { projectId?: string; compact?: boolean }) {
  const { projects, settings } = useApp();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [error, setError] = useState<string | null>(null);
  const valid = isSharePointUrl(url);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const folder = newFolder(url, name);
    if (!folder) { setError('Pega un enlace de SharePoint (https://….sharepoint.com/…).'); return; }
    const target = fixedProject ?? (projectId || null);
    await saveFolders(target, [...foldersOf(target, projects, settings), folder], `Carpeta «${folder.name}» añadida`);
    track('sharepoint', target ? 'add-project' : 'add-personal');
    setUrl(''); setName(''); setError(null);
  };

  return (
    <form onSubmit={(e) => void add(e)} className={`flex flex-wrap items-center gap-2 ${compact ? '' : ''}`}>
      <input value={url} onChange={(e) => { setUrl(e.target.value); setError(null); }} placeholder="Enlace de la carpeta en SharePoint" aria-label="Enlace de la carpeta"
        className={`${inputClass} min-w-56 flex-[2] ${url && !valid ? 'border-red-400' : ''}`} />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre (opcional)" aria-label="Nombre de la carpeta" maxLength={120}
        className={`${inputClass} min-w-32 flex-1`} />
      {!fixedProject && (
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Dónde guardarla" className={`${inputClass} w-auto`}>
          <option value="">Personal (solo yo)</option>
          <ProjectOptions />
        </select>
      )}
      <button type="submit" disabled={!valid}
        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
        <FolderPlus className="size-4" />Añadir
      </button>
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
      {!fixedProject && projectId && <p className="w-full text-xs text-zinc-500">Las carpetas de un proyecto las ve quien ve el proyecto.</p>}
    </form>
  );
}

export function FolderRow({ folder, projectId }: { folder: SharePointFolder; projectId: string | null }) {
  const { projects, settings } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const list = foldersOf(projectId, projects, settings);
  const rename = async () => {
    setEditing(false);
    const n = name.trim();
    if (!n || n === folder.name) { setName(folder.name); return; }
    await saveFolders(projectId, list.map((f) => (f.id === folder.id ? { ...f, name: n.slice(0, 120) } : f)), 'Carpeta renombrada');
  };
  const remove = async () => {
    if (!window.confirm(`¿Quitar el acceso «${folder.name}»? La carpeta no se toca en SharePoint.`)) return;
    await saveFolders(projectId, list.filter((f) => f.id !== folder.id), `Carpeta «${folder.name}» quitada`);
  };
  const where = (() => { try { const u = new URL(folder.url); return u.hostname.split('.')[0]; } catch { return ''; } })();
  return (
    <li className="group flex items-center gap-2 px-3 py-2 text-sm">
      <Folder className="size-4 shrink-0 text-amber-500" />
      {editing ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} aria-label="Nombre de la carpeta"
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(folder.name); setEditing(false); } }}
          className={`${inputClass} flex-1 py-0.5`} />
      ) : (
        <a href={folder.url} target="_blank" rel="noopener noreferrer" onClick={() => track('sharepoint', 'open')}
          className="min-w-0 flex-1 truncate font-medium hover:underline" title={folder.url}>{folder.name}</a>
      )}
      <span className="hidden shrink-0 text-xs text-zinc-400 sm:inline">{where}</span>
      <span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
        <a href={folder.url} target="_blank" rel="noopener noreferrer" title="Abrir en SharePoint" aria-label={`Abrir ${folder.name} en SharePoint`}
          className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ExternalLink className="size-3.5" /></a>
        <button type="button" onClick={() => setEditing(true)} title="Cambiar el nombre" aria-label={`Cambiar el nombre de ${folder.name}`}
          className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil className="size-3.5" /></button>
        <button type="button" onClick={() => void remove()} title="Quitar el acceso" aria-label={`Quitar ${folder.name}`}
          className="rounded p-1 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"><Trash2 className="size-3.5" /></button>
      </span>
    </li>
  );
}

// ───────────────────────────── Contenido (marcador) ─────────────────────────────

function FolderContents() {
  const { snapshot, error, loading, connected } = useSharePointSnapshot();
  const { projects, settings, today } = useApp();
  const [q, setQ] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<SharePointEntry | null>(null);
  useEffect(() => { setSaved(false); setQ(''); }, [snapshot]);
  const shown = useMemo(() => (snapshot?.entries ?? []).filter((e) => !q.trim() || fold(e.name).includes(fold(q.trim()))), [snapshot, q]);
  const crumbs = snapshot ? breadcrumbs(snapshot.path, snapshot.site) : [];
  const folderName = crumbs[crumbs.length - 1]?.name ?? snapshot?.path.split('/').filter(Boolean).pop() ?? 'Carpeta';
  const alreadySaved = !!snapshot && settings.sharepoint_folders.concat(projects.flatMap((p) => p.folders ?? [])).some((f) => f.url === snapshot.url);

  const save = async () => {
    if (!snapshot) return;
    const folder = newFolder(snapshot.url, folderName);
    if (!folder) return;
    await saveFolders(null, [...settings.sharepoint_folders, folder], `Carpeta «${folder.name}» añadida`);
    setSaved(true);
    track('sharepoint', 'save-snapshot');
  };
  const go = (path: string) => { track('sharepoint', 'navigate'); void openFolder(path); };

  return (
    <section className={card}>
      <h2 className={title}><Bookmark className="size-4 text-[var(--marc)]" />Ver lo que hay en una carpeta</h2>
      {!snapshot && <BookmarkletSetup />}
      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {snapshot && (
        <div>
          <nav className="mb-2 flex flex-wrap items-center gap-1 text-sm" aria-label="Carpetas">
            <Folder className="size-4 text-amber-500" />
            {crumbs.map((c, i) => (
              <span key={c.path} className="inline-flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 text-zinc-400" />}
                {i === crumbs.length - 1
                  ? <span className="font-semibold">{c.name}</span>
                  : <button type="button" disabled={!connected || loading} onClick={() => go(c.path)} className="text-indigo-700 hover:underline disabled:text-zinc-500 disabled:no-underline dark:text-indigo-300">{c.name}</button>}
              </span>
            ))}
            {!crumbs.length && <span className="font-semibold">{snapshot.path}</span>}
            {loading && <Loader2 className="ml-1 size-4 animate-spin text-zinc-400" />}
            <span className="ml-auto flex flex-wrap gap-1.5">
              <a href={snapshot.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
                <ExternalLink className="size-3.5" />Abrir en SharePoint
              </a>
              <button type="button" disabled={alreadySaved || saved} onClick={() => void save()}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                {alreadySaved || saved ? <><Check className="size-3.5" />En mis carpetas</> : <><FolderPlus className="size-3.5" />Guardar en mis carpetas</>}
              </button>
              <button type="button" onClick={() => { setSnapshot(null); setPreview(null); }} title="Dejar de verla" aria-label="Dejar de ver la carpeta"
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
            </span>
          </nav>
          <p className="mb-2 text-xs text-zinc-500">
            {snapshot.entries.length} elementos{snapshot.truncated && ' (hay más: ábrela en SharePoint)'} · solo en esta pestaña, no se guarda ·{' '}
            {connected
              ? <span className="text-emerald-700 dark:text-emerald-400">conectado con SharePoint: entra en las carpetas desde aquí (deja abierta su pestaña)</span>
              : <span>para moverte por las carpetas desde aquí, vuelve a pulsar el marcador</span>}
          </p>
          <div className={`mb-2 flex items-center gap-1.5 ${inputClass}`}>
            <Search className="size-4 text-zinc-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por nombre…" aria-label="Filtrar archivos" className="w-full bg-transparent outline-none" />
          </div>
          <div className={`grid gap-3 ${preview ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
            <ul className={`max-h-[65vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800 ${loading ? 'opacity-60' : ''}`}>
              {shown.map((e) => {
                const canPreview = e.kind === 'file' && connected && !!previewType(e.name) && (e.size ?? 0) <= MAX_PREVIEW_BYTES;
                const inside = e.kind === 'folder' && connected;
                const rowClass = `flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${preview?.path === e.path ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}`;
                const body = (
                  <>
                    {e.kind === 'folder' ? <Folder className="size-4 shrink-0 text-amber-500" /> : <FileText className="size-4 shrink-0 text-zinc-400" />}
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="shrink-0 text-xs text-zinc-400">{e.kind === 'folder' ? (e.size !== null ? `${e.size} elementos` : '') : fileSize(e.size)}</span>
                    <span className="hidden w-24 shrink-0 text-right text-xs text-zinc-400 sm:inline">{e.modified ? formatDay(e.modified.slice(0, 10), today) : ''}</span>
                  </>
                );
                return (
                  <li key={e.path} className="group flex items-center">
                    {inside || canPreview
                      ? <button type="button" disabled={loading} className={rowClass} title={inside ? 'Entrar en la carpeta' : 'Ver aquí'}
                          onClick={() => (inside ? go(e.path) : (track('sharepoint', 'preview'), setPreview(e)))}>{body}</button>
                      : <a href={e.url} target="_blank" rel="noopener noreferrer" className={rowClass} title="Abrir en SharePoint">{body}</a>}
                    <a href={e.url} target="_blank" rel="noopener noreferrer" title="Abrir en SharePoint" aria-label={`Abrir ${e.name} en SharePoint`}
                      className="mr-1 shrink-0 rounded p-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
                      <ExternalLink className="size-3.5" /></a>
                  </li>
                );
              })}
              {!shown.length && <li className="px-3 py-3 text-sm text-zinc-400">{q ? 'Nada con ese nombre.' : 'La carpeta está vacía.'}</li>}
            </ul>
            {preview && <Preview key={preview.path} entry={preview} onClose={() => setPreview(null)} />}
          </div>
          <details className="mt-3 text-xs text-zinc-500">
            <summary className="cursor-pointer">El marcador</summary>
            <div className="mt-2"><BookmarkletSetup /></div>
          </details>
        </div>
      )}
    </section>
  );
}

/**
 * Vista previa de un PDF o una imagen dentro de Marea: el archivo llega del puente y vive solo como `blob:` de esta pestaña;
 * al cerrar la vista previa (o cambiar de archivo) se libera.
 */
function Preview({ entry, onClose }: { entry: SharePointEntry; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = previewType(entry.name);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    if (!type) { setError('Este tipo de archivo se abre en SharePoint.'); return; }
    loadFile(entry.path, type, MAX_PREVIEW_BYTES).then(
      (u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u); },
      (e: Error) => { if (live) setError(e.message); },
    );
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [entry.path, type]);
  return (
    <div className="flex max-h-[65vh] min-h-80 flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 text-sm dark:border-zinc-800">
        <FileText className="size-4 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-medium" title={entry.name}>{entry.name}</span>
        <a href={entry.url} target="_blank" rel="noopener noreferrer" title="Abrir en SharePoint" aria-label="Abrir en SharePoint"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ExternalLink className="size-3.5" /></a>
        <button type="button" onClick={onClose} title="Cerrar la vista previa" aria-label="Cerrar la vista previa"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 bg-zinc-50 dark:bg-zinc-950">
        {error && <p className="m-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
        {!url && !error && <p className="flex items-center gap-2 p-3 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />Trayendo el archivo de SharePoint…</p>}
        {url && type === 'application/pdf' && <iframe src={url} title={entry.name} className="h-full min-h-[60vh] w-full" />}
        {url && type !== 'application/pdf' && <img src={url} alt={entry.name} className="mx-auto max-h-[60vh] max-w-full object-contain p-2" />}
      </div>
      <p className="border-t border-zinc-200 px-3 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">Solo en esta pestaña: al cerrar la vista previa se borra.</p>
    </div>
  );
}

/** El marcador para arrastrar a la barra de marcadores (o copiar el código, si la página no deja ejecutarlo). */
function BookmarkletSetup() {
  const app = window.location.origin;
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  // React no deja poner un href `javascript:` en JSX: se pone a mano.
  useEffect(() => { ref.current?.setAttribute('href', bookmarkletHref(app)); }, [app]);
  return (
    <div className="text-sm">
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
        <li>Arrastra el botón <b>Marea · Carpeta</b> a la barra de marcadores del navegador (solo la primera vez).</li>
        <li>Abre en SharePoint la carpeta que quieras ver, con tu cuenta de CaixaBank.</li>
        <li>Pulsa el marcador: Marea se abre aquí con lo que hay en esa carpeta. Deja abierta la pestaña de SharePoint y podrás entrar en las subcarpetas y ver PDF e imágenes desde aquí.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <a ref={ref} draggable onClick={(e) => { e.preventDefault(); window.alert('Arrástralo a la barra de marcadores y púlsalo estando en una carpeta de SharePoint.'); }}
          className="inline-flex cursor-grab items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
          <Bookmark className="size-4" />Marea · Carpeta
        </a>
        <button type="button" onClick={() => { void navigator.clipboard.writeText(bookmarkletCode(app)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? 'Copiado' : 'Copiar el código'}
        </button>
        <span className="text-xs text-zinc-500">Si la página no deja usar marcadores, pega el código en la consola (F12) estando en la carpeta.</span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">El marcador lee con tu sesión nombres, fechas y tamaños de las carpetas de ese sitio. Solo trae un archivo cuando pides verlo (PDF o imagen, hasta 20 MB), y se queda en esta pestaña sin guardarse.</p>
    </div>
  );
}
