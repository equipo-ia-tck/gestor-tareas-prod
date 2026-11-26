import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bookmark, Check, ChevronRight, Puzzle, Copy, ExternalLink, FileText, Folder, FolderPlus, Loader2, Pencil, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { ViewHeader } from '../views/ViewHeader';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { breadcrumbs, fileSize, isSharePointOrigin, isSharePointUrl, MAX_PREVIEW_BYTES, previewType, type SharePointEntry, type SharePointFolder } from '../../domain/sharepoint';
import { formatDay } from '../../domain/dates';
import { fold } from '../../domain/text';
import { track } from '../usage/track';
import { bookmarkletCode, bookmarkletHref } from './bookmarklet';
import { foldersOf, newFolder, saveFolders } from './folders';
import { canUpload, cancelWaiting, extensionReady, handleBridgeMessage, loadFile, openFolder, uploadFiles, type UploadResult, openForBridge, openWithExtension, setSnapshot, showFolder, useSharePointSnapshot } from './sharepointStore';
import { isOutdated, LATEST_EXTENSION, useExtension } from '../mslist/extension';
import { navigate } from '../../app/router';
import { ClaudeAccessCard } from './SharePointClaude';

const card = 'rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900';
const title = 'mb-3 flex items-center gap-2 text-sm font-semibold';

/**
 * Pantalla SharePoint (`#/sharepoint`): accesos a las carpetas del SharePoint de CaixaBank (se abren con la cuenta de
 * proveedor externo; Marea solo guarda nombre y enlace) y, con el marcador, lo que hay dentro de una carpeta, que solo se
 * ve en esta pestaña.
 */
export function SharePointView() {
  useBookmarkletBridge();
  useWideLayout(true);
  return (
    <>
      <ViewHeader title="SharePoint" subtitle="Las carpetas de CaixaBank con las que trabajas, a un clic. Se abren con tu cuenta de proveedor externo." />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <span>Marea solo guarda el nombre y el enlace de cada carpeta. Los documentos se quedan en SharePoint y se abren con tus
          permisos de CaixaBank. Lo que veas con el marcador no se guarda en ningún sitio: al cerrar esta pestaña desaparece.</span>
      </p>
      <ClaudeAccessCard />
      {/* Mis carpetas a la izquierda y su contenido a la derecha (en pantallas estrechas, una debajo de otra). */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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

/**
 * Pulsar una carpeta guardada: se ve dentro de Marea (al momento si ya está conectado el marcador; si no, con los pasos
 * para conectar). Si el enlace no dice qué carpeta es, se abre en SharePoint.
 */
export async function openSaved(folder: SharePointFolder) {
  track('sharepoint', 'open');
  // 1) Con la extensión de Chrome: al momento, sin pestaña de SharePoint ni marcador.
  if (extensionReady()) {
    navigate({ view: 'sharepoint' });
    setTimeout(() => document.getElementById('sp-contents')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    await openWithExtension(folder.url);
    return;
  }
  // 2) Sin la extensión, el puente del marcador.
  if (!showFolder(folder)) { window.open(folder.url, '_blank', 'noopener,noreferrer'); return; }
  navigate({ view: 'sharepoint' });
  setTimeout(() => document.getElementById('sp-contents')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
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
        <button type="button" onClick={() => void openSaved(folder)} title="Ver dentro de Marea"
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline">{folder.name}</button>
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
  const { snapshot, error, loading, connected, waitingFor, via, focus } = useSharePointSnapshot();
  const { projects, settings, today } = useApp();
  const [q, setQ] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<SharePointEntry | null>(null);
  useEffect(() => { setSaved(false); setQ(''); }, [snapshot]);
  // Abierto desde un enlace a un archivo: se marca y, si es PDF o imagen, se ve.
  const focused = focus && snapshot ? snapshot.entries.find((e) => e.path.toLowerCase() === focus.toLowerCase()) ?? null : null;
  useEffect(() => {
    if (!focused) return;
    document.querySelector(`[data-sp-path="${CSS.escape(focused.path)}"]`)?.scrollIntoView({ block: 'center' });
    if (previewType(focused.name) && (focused.size ?? 0) <= (via === 'extension' ? EXT_PREVIEW_BYTES : MAX_PREVIEW_BYTES)) setPreview(focused);
  }, [focused, via]);
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
  const uploadable = !!snapshot && via === 'extension' && canUpload();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length || progress) return;
    setResults(null);
    setProgress({ done: 0, total: files.length });
    try {
      const r = await uploadFiles(files, (done, total) => setProgress({ done, total }));
      setResults(r);
      track('sharepoint', 'upload', r.filter((x) => !x.error).length);
    } catch (e) {
      setResults(files.map((f) => ({ name: f.name, error: (e as Error).message })));
    } finally {
      setProgress(null);
    }
  };
  const hasFiles = (e: React.DragEvent) => uploadable && [...e.dataTransfer.types].includes('Files');

  return (
    <section id="sp-contents" className={card}>
      <h2 className={title}><Bookmark className="size-4 text-[var(--marc)]" />Ver lo que hay en una carpeta</h2>
      {waitingFor && <ConnectFirst folder={waitingFor} />}
      {!snapshot && !waitingFor && <ContentsSetup />}
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
              {uploadable && (
                <button type="button" disabled={!!progress} onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                  <Upload className="size-3.5" />Subir archivos
                </button>
              )}
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
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
            {via === 'extension'
              ? <span className="text-emerald-700 dark:text-emerald-400">con la extensión de Chrome: entra en las carpetas desde aquí y arrastra archivos para subirlos</span>
              : connected
                ? <span className="text-emerald-700 dark:text-emerald-400">conectado con SharePoint: entra en las carpetas desde aquí (deja abierta su pestaña)</span>
                : <span>para moverte por las carpetas desde aquí, vuelve a pulsar el marcador</span>}
          </p>
          {progress && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
              <Loader2 className="size-3.5 animate-spin" />Subiendo {Math.min(progress.done + 1, progress.total)} de {progress.total}…
            </p>
          )}
          {results && (
            <div className="mb-2 rounded-md border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">
                  {results.filter((r) => !r.error).length} de {results.length} subidos a «{folderName}»
                </p>
                <button type="button" onClick={() => setResults(null)} aria-label="Cerrar" className="rounded p-0.5 text-zinc-400 hover:text-zinc-700"><X className="size-3.5" /></button>
              </div>
              {results.filter((r) => r.error).map((r) => (
                <p key={r.name} className="text-amber-700 dark:text-amber-400">{r.name}: {r.error}</p>
              ))}
            </div>
          )}
          <div className={`mb-2 flex items-center gap-1.5 ${inputClass}`}>
            <Search className="size-4 text-zinc-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por nombre…" aria-label="Filtrar archivos" className="w-full bg-transparent outline-none" />
          </div>
          <div className={`grid gap-3 ${preview ? '2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
            <ul className={`max-h-[65vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border dark:divide-zinc-800 ${dragging ? 'border-dashed border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30' : 'border-zinc-200 dark:border-zinc-800'} ${loading ? 'opacity-60' : ''}`}
              onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}>
              {shown.map((e) => {
                const canPreview = e.kind === 'file' && connected && !!previewType(e.name) && (e.size ?? 0) <= (via === 'extension' ? EXT_PREVIEW_BYTES : MAX_PREVIEW_BYTES);
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
                  <li key={e.path} data-sp-path={e.path} className={`group flex items-center ${focused?.path === e.path ? 'bg-amber-50 ring-1 ring-amber-300 ring-inset dark:bg-amber-950/30' : ''}`}>
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

const EXTENSION_ZIP = 'marea-lista-extension.zip';
/** La extensión trae hasta 10 MB para la vista previa (el marcador, 20). */
const EXT_PREVIEW_BYTES = 10 * 1024 * 1024;

/**
 * Sin carpeta abierta: con la extensión de Chrome «Marea · Lista» (1.5.0+) se abre cualquier carpeta al momento, sin
 * pestaña de SharePoint; sin ella, cómo instalarla o actualizarla, y el marcador como alternativa.
 */
function ContentsSetup() {
  const extension = useExtension();
  const [url, setUrl] = useState('');
  const ready = !!extension && !isOutdated(extension);
  const open = () => { if (isSharePointUrl(url)) { track('sharepoint', 'open-link'); void openWithExtension(url.trim()); } };
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 dark:border-teal-900 dark:bg-teal-950/30">
        <p className="mb-2 flex items-center gap-2 font-semibold"><Puzzle className="size-4" />Con la extensión de Chrome
          <span className="font-normal text-zinc-500">(recomendado: sin tener SharePoint abierto)</span></p>
        {ready ? (
          <>
            <p className="mb-2 text-emerald-700 dark:text-emerald-300">✓ Extensión «Marea · Lista» instalada (versión {extension}). Pulsa una de tus carpetas o pega aquí el enlace de otra:</p>
            <div className="flex gap-2">
              <input className={`${inputClass} min-w-0 flex-1 py-1`} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
                placeholder="https://….sharepoint.com/sites/…" aria-label="Enlace de una carpeta de SharePoint" />
              <button type="button" onClick={open} disabled={!isSharePointUrl(url)}
                className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Abrir aquí</button>
            </div>
          </>
        ) : extension ? (
          <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
            Para ver carpetas hace falta la versión {LATEST_EXTENSION} de la extensión (tienes la {extension}).{' '}
            <a href={`/${EXTENSION_ZIP}`} download className="font-medium underline">Descárgala</a>, sustituye la carpeta <code>marea-lista</code> por la
            nueva y, en <code>chrome://extensions</code>, pulsa el botón de recargar (↻) de «Marea · Lista». Después recarga esta página.
          </p>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
            <li><a href={`/${EXTENSION_ZIP}`} download className="font-medium text-indigo-600 underline dark:text-indigo-400">Descarga la extensión</a> y
              descomprímela: queda una carpeta <code>marea-lista</code>. Déjala en un sitio fijo (p. ej. Documentos).</li>
            <li>Abre <code>chrome://extensions</code>, activa <b>Modo de desarrollador</b> y pulsa <b>Cargar descomprimida</b> con esa carpeta.</li>
            <li>Recarga esta página. Es la misma extensión que la de la Lista: si ya la tienes, solo hay que actualizarla.</li>
          </ol>
        )}
        <p className="mt-2 text-xs text-zinc-500">Funciona con Chrome abierto y la sesión de SharePoint de CaixaBank iniciada en Chrome. Solo lee nombres, fechas y tamaños; un archivo, solo cuando pides verlo (PDF o imagen), y no se guarda.</p>
      </div>
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Sin extensión: con el marcador</summary>
        <div className="mt-2"><BookmarkletSetup /></div>
      </details>
    </div>
  );
}

/** Se ha pedido una carpeta guardada y aún no hay puente con ese SharePoint: los pasos para conectar (una vez). */
function ConnectFirst({ folder }: { folder: SharePointFolder }) {
  return (
    <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      <p className="mb-2 font-semibold">Para ver «{folder.name}» aquí, conecta con SharePoint (una vez por sesión):</p>
      <ol className="mb-3 list-decimal space-y-1 pl-5">
        <li>
          <button type="button" onClick={() => openForBridge(folder.url)}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700">
            <ExternalLink className="size-3.5" />Abrir «{folder.name}» en SharePoint
          </button>
        </li>
        <li>En esa pestaña, pulsa el marcador <b>Marea · Carpeta</b> de tu barra de marcadores (si no sale el aviso azul abajo a la derecha, mira «¿Aún no tienes el marcador?»: se puede pegar en la consola).</li>
        <li>La carpeta aparece aquí sola. Deja abierta la pestaña de SharePoint: así las demás carpetas se abren aquí directamente.</li>
      </ol>
      <details className="text-xs text-zinc-600 dark:text-zinc-300">
        <summary className="cursor-pointer">¿Aún no tienes el marcador?</summary>
        <div className="mt-2"><BookmarkletSetup /></div>
      </details>
      <button type="button" onClick={cancelWaiting} className="mt-2 text-xs text-zinc-500 underline">Cancelar</button>
    </div>
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
        <span className="text-xs text-zinc-500">
          <b>Si al pulsarlo no sale nada</b> (abajo a la derecha tiene que aparecer un aviso azul «Marea · …»), SharePoint está
          bloqueando los marcadores: pulsa «Copiar el código» y, en la pestaña de SharePoint, abre la consola (⌥⌘J en Chrome,
          F12 en Windows), pégalo y pulsa Enter. Chrome puede pedirte que escribas «allow pasting» la primera vez.
        </span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">El marcador lee con tu sesión nombres, fechas y tamaños de las carpetas de ese sitio. Solo trae un archivo cuando pides verlo (PDF o imagen, hasta 20 MB), y se queda en esta pestaña sin guardarse.</p>
    </div>
  );
}
