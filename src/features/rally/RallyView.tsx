import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Columns3, ExternalLink, Layers, Plus, RefreshCw, Search, Unplug, Wand2, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { ActionButton, Section } from '../../components/TaskList';
import { Avatar } from '../../components/ui/Badges';
import { Popover } from '../../components/ui/Popover';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import {
  boardColumnOf, groupRally, linkedTask, RALLY_COLUMNS, RALLY_KINDS, taskFromRally, tasksByRallyId,
  type RallyGroupBy, type RallyItem, type RallyKind, type RallyPick, type RallyProject, type RallyRef, type RallyStatus,
} from '../../domain/rally';
import { usePersistentState } from '../../hooks/usePersistentState';
import { inRallyView, RALLY_VIEWS } from '../../domain/rallyViews';
import type { Task } from '../../domain/types';
import { fold } from '../../domain/text';
import { useWideLayout } from '../../app/Layout';
import { ViewHeader } from '../views/ViewHeader';
import { RallyCreateForm, type RallyPrefill } from './RallyCreateForm';
import { RallyRequestDialog } from './RallyRequestDialog';
import { RallyDetailPanel } from './RallyDetailPanel';
import { rallyApi } from './rallyApi';
import { track, trackState } from '../usage/track';
import { applyRallyStates } from './rallyStates';
import { ValuesField } from './RallyPickers';

const REFRESH_MS = 5 * 60_000;

/**
 * Rally: lo asignado a la persona o lo de los proyectos elegidos en el banner, con "Añadir al gestor" para traer cada
 * elemento como tarea (con su ID y enlace).
 */
export function RallyView() {
  const [status, setStatus] = useState<RallyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rallyApi.status().then(setStatus, (e: Error) => setError(e.message));
  }, []);

  return (
    <>
      {/* Conectado, la cabecera la pone RallyItems (con el buscador y los botones a la derecha, como en Rally). */}
      {!status?.connected && (
        <ViewHeader title={<span className="inline-flex items-center gap-2"><Layers className="size-5 text-indigo-500" />Rally</span>}
          subtitle="Conecta tu cuenta de Rally con una clave de API" />
      )}
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {status && (status.connected
        ? <RallyItems user={status.rallyUser} onDisconnect={() => { if (confirm('¿Desconectar Rally? Se borra tu clave del servidor. Las tareas ya añadidas se quedan.')) void rallyApi.disconnect().then(setStatus); }} />
        : <ConnectForm initialUrl={status.baseUrl} onConnected={setStatus} />)}
    </>
  );
}

function ConnectForm({ initialUrl, onConnected }: { initialUrl: string; onConnected: (s: RallyStatus) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onConnected(await rallyApi.connect(apiKey, baseUrl));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-700">
        <h2 className="mb-2 font-semibold">Cómo conseguir la clave de API</h2>
        <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
          <li>Abre <a className="text-indigo-600 hover:underline" href="https://eu1.rallydev.com/login" target="_blank" rel="noreferrer">eu1.rallydev.com/login</a> y entra con tu usuario.</li>
          <li>Haz clic en <b>API Keys</b> (arriba a la derecha de esa página, o en tu perfil de Rally).</li>
          <li>Pulsa <b>Create New API Key</b>, ponle una descripción (p. ej. «Gestor de tareas») y elige <b>Full Access</b> (para crear, mover y comentar desde aquí; con Read-Only solo se puede leer).</li>
          <li>Copia la clave (empieza por <code>_</code>) y pégala aquí debajo.</li>
        </ol>
        <p className="mt-2 text-xs text-zinc-500">
          La clave se guarda solo en el servidor del gestor y nunca vuelve al navegador. Si no ves «API Keys», el administrador
          de Rally del cliente las ha restringido y hay que pedírselo. Si tu Rally tiene otra dirección, cámbiala abajo.
        </p>
      </section>
      <form onSubmit={submit} className="space-y-2">
        <input className={inputClass} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Clave de API de Rally" autoComplete="off" />
        <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://eu1.rallydev.com" aria-label="Dirección de Rally" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy || !apiKey.trim()} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? 'Comprobando…' : 'Conectar'}
        </button>
      </form>
    </div>
  );
}

/** Como `inputClass`, pero sin ocupar todo el ancho (para ponerlo en una fila con más cosas). */
const fieldClass = 'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-800';

const chipClass = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-xs font-medium ${on
  ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'}`;

/** Proyecto que se elige solo la primera vez (el del equipo). */
const DEFAULT_PROJECT = 'Team.Digital Data';
const MAX_RECENT = 5;

/**
 * Proyectos de Rally en un desplegable, como el selector de proyecto de Rally: recientes, buscador y todos los proyectos
 * (se pueden marcar varios), y «Show items from» con los padres y los hijos de los elegidos.
 */
function ProjectPicker({ projects, selected, onChange, scope, onScope, recent }: {
  projects: RallyProject[];
  selected: string[];
  onChange: (ids: string[]) => void;
  scope: { down: boolean; up: boolean };
  onScope: (s: { down: boolean; up: boolean }) => void;
  recent: string[];
}) {
  const [q, setQ] = useState('');
  const byId = new Map(projects.map((p) => [p.id, p]));
  const names = selected.map((id) => byId.get(id)?.name).filter(Boolean) as string[];
  const label = names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}` : 'Elegir proyecto';
  const query = fold(q.trim());
  const list = query ? projects.filter((p) => fold(p.name).includes(query)) : projects;
  const recents = recent.map((id) => byId.get(id)).filter((p): p is RallyProject => !!p);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const row = (p: RallyProject) => (
    <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
      <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
      <span className={`truncate ${selected.includes(p.id) ? 'font-medium' : ''}`} title={p.name}>{p.name}</span>
    </label>
  );
  return (
    <Popover width="w-80" trigger={(open, isOpen) => (
      <button type="button" onClick={open} aria-expanded={isOpen} title={names.join(', ') || undefined}
        className="inline-flex max-w-72 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm hover:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-900">
        <span className="min-w-0 truncate font-medium">{label}</span>
        {names.length > 0 && (scope.down || scope.up) && (
          <span className="shrink-0 text-[11px] text-emerald-700 dark:text-emerald-400">{scope.down ? '↓ Children' : ''}{scope.down && scope.up ? ' ' : ''}{scope.up ? '↑ Parents' : ''}</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-zinc-400" />
      </button>
    )}>
      {() => (
        <div className="p-1 text-sm">
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Buscar entre ${projects.length} proyectos…`} aria-label="Buscar proyecto de Rally"
              className="w-full rounded-md border border-zinc-200 bg-white py-1 pr-2 pl-7 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
          {!query && recents.length > 0 && (
            <>
              <p className="px-2 pt-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Recientes</p>
              {recents.map(row)}
              <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            </>
          )}
          <div className="max-h-72 overflow-y-auto">
            {list.map(row)}
            {!list.length && <p className="px-2 py-1 text-xs text-zinc-400">Ningún proyecto con ese nombre.</p>}
          </div>
          <div className="mt-1 border-t border-zinc-100 px-2 pt-1.5 dark:border-zinc-800">
            <p className="mb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Ver también</p>
            <label className="flex cursor-pointer items-center gap-2 py-0.5">
              <input type="checkbox" checked={scope.up} onChange={(e) => onScope({ ...scope, up: e.target.checked })} />↑ Proyectos padre (Parent Projects)
            </label>
            <label className="flex cursor-pointer items-center gap-2 py-0.5">
              <input type="checkbox" checked={scope.down} onChange={(e) => onScope({ ...scope, down: e.target.checked })} />↓ Proyectos hijo (Child Projects)
            </label>
            {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="mt-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400">Quitar todos (ver lo asignado a mí)</button>}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Qué se enseña en cada fila (se recuerda en localStorage). Lo secundario va debajo del nombre, así el nombre cabe entero. */
interface RallyColumns {
  owner: boolean; state: boolean; assignee: boolean; tags: boolean; project: boolean; iteration: boolean;
  /** El nombre en varias líneas (si no, en una y cortado). */
  wrap: boolean;
}
const DEFAULT_COLUMNS: RallyColumns = { owner: true, state: true, assignee: true, tags: true, project: true, iteration: false, wrap: true };
const COLUMN_LABELS: [keyof RallyColumns, string][] = [
  ['wrap', 'Nombre completo (en varias líneas)'], ['owner', 'Owner'], ['state', 'Estado'],
  ['assignee', 'Asignado a (debajo del nombre)'], ['tags', 'Etiquetas (debajo)'], ['project', 'Proyecto (debajo)'], ['iteration', 'Iteración (debajo)'],
];

/** Ancho en píxeles de las columnas fijas (se arrastra el borde de la cabecera; doble clic vuelve al de serie). */
interface RallyWidths { id: number; owner: number; state: number }
const DEFAULT_WIDTHS: RallyWidths = { id: 96, owner: 160, state: 144 };

/**
 * Asa para ensanchar o estrechar una columna de la cabecera. `side`: en qué borde está (las de la derecha del nombre crecen
 * hacia la izquierda, quitándole sitio al nombre).
 */
function ResizeHandle({ width, onChange, onReset, side }: { width: number; onChange: (w: number) => void; onReset: () => void; side: 'left' | 'right' }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      title="Arrastra para cambiar el ancho · doble clic: el de serie"
      onDoubleClick={onReset}
      onMouseDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        const move = (ev: MouseEvent) => {
          const dx = ev.clientX - x0;
          onChange(Math.round(Math.min(480, Math.max(56, side === 'right' ? width + dx : width - dx))));
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
        document.body.style.cursor = 'col-resize';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      className={`absolute top-0 bottom-0 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-zinc-300 hover:after:bg-indigo-500 dark:after:bg-zinc-600 ${side === 'right' ? '-right-1' : '-left-1'}`}
    />
  );
}

const NO_GROUP: Partial<Record<RallyGroupBy, string>> = { iteration: 'Sin iteración', assignee: 'Sin asignar', tag: 'Sin etiqueta' };

function RallyItems({ user, onDisconnect }: { user: string | null; onDisconnect: () => void }) {
  const { tasks, itemTypes, projects, editTask, closeDetail } = useApp();
  const [rallyProjects, setRallyProjects] = useState<RallyProject[] | null>(null);
  const [items, setItems] = useState<RallyItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  // Tipos con más elementos de los que se traen (5.000 por tipo): se avisa para acotar.
  const [truncated, setTruncated] = useState<{ kind: RallyKind; total: number; shown: number }[]>([]);
  // null = aún no se ha elegido nunca: se pone Team.Digital Data al cargar los proyectos. Después, lo último elegido.
  const [storedSelected, setStoredSelected] = usePersistentState<string[] | null>('rally-projects-v2', null);
  const selected = storedSelected ?? [];
  const [recent, setRecent] = usePersistentState<string[]>('rally-recent-projects', []);
  const setSelected = (ids: string[]) => {
    setStoredSelected(ids);
    const added = ids.filter((id) => !selected.includes(id));
    if (added.length) setRecent([...added, ...recent.filter((id) => !added.includes(id))].slice(0, MAX_RECENT));
  };
  const [scope, setScope] = usePersistentState('rally-scope', { down: true, up: true });
  const [viewId, setViewId] = usePersistentState('rally-view', 'default');
  const view = RALLY_VIEWS.find((v) => v.id === viewId) ?? RALLY_VIEWS[0];
  // Filtro por etiquetas de Rally: los test sets no tienen Assignee y se reparten por etiqueta.
  const [tags, setTags] = usePersistentState<RallyRef[]>('rally-tag-filter', []);
  const [kinds, setKinds] = usePersistentState<RallyKind[]>('rally-kinds', RALLY_KINDS.map((k) => k.kind));
  const [hideDone, setHideDone] = usePersistentState('rally-hide-done', false);
  // Siempre por las columnas del tablero de Rally (New, Defined…), como la lista de Rally.
  const groupBy = 'column' as RallyGroupBy;
  const [projectId, setProjectId] = usePersistentState('rally-project', '');
  // Elemento abierto en el panel de la derecha.
  const [open, setOpen] = useState<RallyItem | null>(null);
  // Buscador: filtra lo cargado y, aparte, busca en todo Rally por ID o palabra.
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  // «Crear con petición»: la frase y, ya interpretada, el formulario relleno.
  const [asking, setAsking] = useState(false);
  const [prefill, setPrefill] = useState<RallyPrefill | null>(null);
  const closePanel = useCallback(() => setOpen(null), []);
  // Con el panel abierto, la vista usa todo el ancho y el panel es una columna más (como en el Tablero).
  // Siempre a todo el ancho: con la ficha abierta y sin ella, para que los nombres quepan.
  useWideLayout(true);
  const [storedColumns, setColumns] = usePersistentState<RallyColumns>('rally-columns', DEFAULT_COLUMNS);
  const cols = { ...DEFAULT_COLUMNS, ...storedColumns };
  // Analítica: qué columnas tiene a la vista cada persona (la última elección cuenta).
  const shownColumns = Object.entries(cols).filter(([, on]) => on).map(([k]) => k).sort().join(',');
  useEffect(() => { trackState('rally-columns', shownColumns); }, [shownColumns]);
  const [storedWidths, setWidths] = usePersistentState<RallyWidths>('rally-widths', DEFAULT_WIDTHS);
  const widths = { ...DEFAULT_WIDTHS, ...storedWidths };
  const resize = (key: keyof RallyWidths, side: 'left' | 'right') => (
    <ResizeHandle side={side} width={widths[key]} onChange={(w) => setWidths({ ...widths, [key]: w })} onReset={() => setWidths({ ...widths, [key]: DEFAULT_WIDTHS[key] })} />
  );

  useEffect(() => {
    rallyApi.projects().then((list) => {
      setRallyProjects(list);
      if (storedSelected === null) {
        const team = list.find((p) => p.name === DEFAULT_PROJECT);
        setStoredSelected(team ? [team.id] : []);
      }
    }, (e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Proyectos elegidos que siguen existiendo (en una cadena, para no recargar en cada render).
  const projectKey = rallyProjects && storedSelected !== null ? selected.filter((id) => rallyProjects.some((p) => p.id === id)).join(',') : null;
  const projectMode = !!projectKey;
  // Nombres de las etiquetas en una cadena, para no recargar en cada render.
  const tagKey = tags.map((t) => t.name).join('\n');
  // Viendo proyectos o etiquetas (no solo «lo asignado a mí»): ahí sirven «Solo lo mío» y el filtro por persona.
  const browsing = projectMode || !!tagKey;

  const load = useCallback(async () => {
    if (projectKey === null) return;
    setLoading(true);
    setError(null);
    try {
      // Todo, sin periodo (como la lista de Rally): lo de los proyectos elegidos, con sus hijos y padres si se marca.
      const { items: loaded, truncated: cut } = await rallyApi.items(0, projectKey ? projectKey.split(',') : [], tagKey ? tagKey.split('\n') : [], scope);
      setItems(loaded);
      setTruncated(cut);
      // De paso, las tareas enlazadas se ponen en la categoría que tienen en Rally.
      void applyRallyStates(loaded).catch(() => {});
      setLoadedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectKey, tagKey, scope.down, scope.up]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setItems(null);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const byId = useMemo(() => tasksByRallyId(tasks), [tasks]);
  const base = (items ?? []).filter((it) => !hideDone || !it.done);
  const searchWords = fold(search).split(/\s+/).filter(Boolean);
  const matchesSearch = (it: RallyItem) => searchWords.every((w) =>
    fold([it.id, it.name, it.owner, it.assignee, it.project, it.iteration, ...it.tags].filter(Boolean).join(' ')).replace(/-/g, '').includes(w.replace(/-/g, '')));
  const inView = base.filter((it) => inRallyView(view, it));
  const visible = inView.filter((it) => kinds.includes(it.kind) && matchesSearch(it));
  const toAdd = visible.filter((it) => !it.done && !linkedTask(it, byId));
  const target = projects.some((p) => p.id === projectId) ? projectId : null;

  const colorOf = (kind: RallyKind) => itemTypes.find((t) => t.short && t.short.toUpperCase() === kind)?.color ?? '#71717a';
  const show = (it: RallyItem) => { closeDetail(); setOpen(it); };
  const openTask = (task: Task) => { setOpen(null); editTask(task); };
  // «Create + New» deja el formulario abierto: el nuevo se suma a la lista sin abrir su ficha.
  const created = (it: RallyItem, addToGestor: boolean, keepOpen: boolean) => {
    if (!keepOpen) { setCreating(false); setPrefill(null); }
    setItems((list) => [it, ...(list ?? []).filter((x) => x.objectId !== it.objectId)]);
    if (addToGestor) void add([it]);
    if (!keepOpen) show(it);
  };
  const add = (list: RallyItem[], mode: 'one' | 'all' = 'one') => {
    track('rally-add', `${mode}.${target ? 'project' : 'none'}`, list.length);
    return addTasks(list);
  };
  const addTasks = (list: RallyItem[]) => repo.batch(list.length === 1 ? `${list[0].id} añadida desde Rally` : `${list.length} añadidas desde Rally`, async () => {
    for (const it of list) await repo.createTask(taskFromRally(it, itemTypes, target));
  });

  return (
    <>
    <ViewHeader
      title={<span className="inline-flex items-center gap-2"><Layers className="size-5 text-indigo-500" />Rally</span>}
      subtitle={`Conectado como ${user ?? '—'}${loadedAt ? ` · actualizado ${loadedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}`}
      actions={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RallySearch value={search} onChange={setSearch} shown={visible.length} onOpen={(it) => { track('rally-button', 'search'); show(it); }} />
          <ActionButton icon={<Plus className="size-4" />} onClick={() => { track('rally-button', 'new'); setPrefill(null); setCreating(!!rallyProjects); }}>Nuevo en Rally</ActionButton>
          <ActionButton icon={<Wand2 className="size-4" />} onClick={() => { track('rally-button', 'request'); setAsking(!!rallyProjects); }}>Crear con petición</ActionButton>
          <ActionButton icon={<RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />} onClick={() => { track('rally-button', 'refresh'); void load(); }}>Actualizar</ActionButton>
          <button type="button" onClick={() => { track('rally-button', 'disconnect'); onDisconnect(); }} title="Borra tu clave de Rally del servidor"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800">
            <Unplug className="size-3.5" />Desconectar
          </button>
        </div>
      )}
    />
    <div className={open ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_460px] xl:items-start xl:gap-6' : ''}>
      <div className="min-w-0">
      <section className="mb-3 space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/40">
        {/* Qué traer de Rally: proyecto, vista guardada y etiquetas, en una línea. */}
        <div className="flex flex-wrap items-center gap-2 xl:flex-nowrap">
          <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">Proyecto</span>
          {rallyProjects
            ? <ProjectPicker projects={rallyProjects} selected={selected} onChange={(ids) => { track('rally-button', 'project'); setSelected(ids); }} scope={scope} onScope={setScope} recent={recent} />
            : <span className="text-xs text-zinc-400">Cargando proyectos…</span>}
          <button type="button" className={chipClass(!browsing)} onClick={() => { track('rally-button', 'mine'); setSelected([]); setTags([]); }} title="Lo que tiene Assignee u Owner = tú">Asignado a mí</button>
          <span className="ml-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300">Vista</span>
          <select value={view.id} onChange={(e) => { track('rally-button', 'view'); setViewId(e.target.value); }} aria-label="Vista guardada" className={`${fieldClass} w-64 shrink-0`}>
            {RALLY_VIEWS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <span className="ml-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300">Etiquetas</span>
          <div className="min-w-64 flex-1">
            <ValuesField title="Filtrar por etiquetas" value={tags} onChange={(t) => { track('rally-button', 'tags'); setTags(t); }} load={rallyApi.tags} recentKey="rally-recent-tags" />
          </div>
        </div>
        {/* Tipos, terminadas y agrupación. */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {RALLY_KINDS.map(({ kind, label }) => {
            const on = kinds.includes(kind);
            return (
              <button key={kind} type="button" title={label} onClick={() => { track('rally-button', 'type'); setKinds(on ? kinds.filter((k) => k !== kind) : [...kinds, kind]); }}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${on ? 'border-indigo-500 bg-white text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'border-zinc-300 text-zinc-500 dark:border-zinc-600'}`}>
                {kind} · {inView.filter((it) => it.kind === kind).length}
              </button>
            );
          })}
          <label className="ml-2 inline-flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={hideDone} onChange={(e) => { track('rally-button', 'hide-done'); setHideDone(e.target.checked); }} /> Ocultar terminadas
          </label>
        </div>
      </section>

      {/* Llevar a mis tareas lo que se ve: cada elemento de Rally pasa a ser una tarea del gestor enlazada (con su ID). */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500" title="Crea en el gestor una tarea por cada elemento de Rally de la lista que aún no tengas. Las tareas quedan enlazadas: cambian de estado solas cuando cambian en Rally.">
          Pasar a mis tareas del gestor, en
        </span>
        <select className={`${fieldClass} w-56`} value={target ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Proyecto del gestor donde se crean las tareas">
          <option value="">Bandeja (sin proyecto)</option>
          <ProjectOptions />
        </select>
        {toAdd.length > 0 ? (
          <ActionButton icon={<Plus className="size-4" />} onClick={() => void add(toAdd, 'all')}
            title="Una tarea por cada elemento pendiente de la lista que aún no está en el gestor (se queda enlazada a Rally)">
            Crear {toAdd.length} {toAdd.length === 1 ? 'tarea' : 'tareas'}
          </ActionButton>
        ) : <span className="text-xs text-zinc-400">Todo lo pendiente de la lista ya está en el gestor.</span>}
      </div>

      {asking && rallyProjects && (
        <RallyRequestDialog projects={rallyProjects} defaultProjectId={selected.find((id) => rallyProjects.some((p) => p.id === id)) ?? null}
          onClose={() => setAsking(false)} onReady={(p) => { setAsking(false); setPrefill(p); setCreating(true); }} />
      )}
      {creating && rallyProjects && (
        <RallyCreateForm key={prefill ? `p:${prefill.source}` : 'nuevo'} prefill={prefill ?? undefined} projects={rallyProjects} defaultProjectId={selected.find((id) => rallyProjects.some((p) => p.id === id)) ?? null} defaultTags={tags}
          onCreated={created} onCancel={() => { setCreating(false); setPrefill(null); }} />
      )}
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {truncated.length > 0 && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          No cabe todo: {truncated.map((t) => `${t.kind} ${t.shown.toLocaleString('es-ES')} de ${t.total.toLocaleString('es-ES')}`).join(' · ')} (se ven las
          más recientes). Acota con las etiquetas o menos proyectos.
        </p>
      )}
      {items === null && !error && <p className="text-sm text-zinc-500">Cargando de Rally…</p>}
      {items !== null && visible.length === 0 && (
        <p className="text-sm text-zinc-500">
          {tagKey ? 'No hay nada con estas etiquetas y estos filtros.' : projectMode ? 'No hay nada en estos proyectos con estos filtros.' : 'No hay nada asignado a ti (Assignee u Owner) con estos filtros. Elige un proyecto arriba.'}
        </p>
      )}

      {visible.length > 0 && (
        <div className="-mx-2 mb-1 hidden gap-2 border-b border-zinc-200 px-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase md:flex dark:border-zinc-700">
          <span className="w-7" /><span className="relative shrink-0" style={{ width: widths.id }}>ID{resize('id', 'right')}</span><span className="flex-1">Name</span>
          {cols.owner && <span className="relative shrink-0 pl-1" style={{ width: widths.owner }}>{resize('owner', 'left')}Owner</span>}
          {cols.state && <span className="relative shrink-0 text-right" style={{ width: widths.state }}>{resize('state', 'left')}Estado</span>}
          {/* Qué columnas se ven: aquí, en la cabecera de la lista. */}
          <span className="flex w-24 justify-end normal-case tracking-normal">
            <Popover align="right" width="w-64" trigger={(toggle, isOpen) => (
              <button type="button" onClick={() => { if (!isOpen) track('rally-button', 'columns'); toggle(); }} aria-expanded={isOpen}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
                <Columns3 className="size-3.5" />Columnas
              </button>
            )}>
              {() => (<div className="p-2 text-sm">
                <p className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Qué ver en cada fila</p>
                {COLUMN_LABELS.map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <input type="checkbox" checked={cols[key]} onChange={(e) => setColumns({ ...cols, [key]: e.target.checked })} />{label}
                  </label>
                ))}
                <button type="button" onClick={() => { setColumns(DEFAULT_COLUMNS); setWidths(DEFAULT_WIDTHS); }} className="mt-1 px-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400">Volver a lo de serie</button>
              </div>)}
            </Popover>
          </span>
        </div>
      )}
      {groupRally(visible, groupBy).map((g) => (
        <Section key={g.key ?? '-'} collapsible title={`${g.key ?? NO_GROUP[groupBy] ?? 'Sin asignar'} · ${g.items.length}`}>
          {g.items.length === 0 && <p className="py-1 text-xs text-zinc-400">Nada en esta categoría.</p>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {g.items.map((it) => {
              const task = linkedTask(it, byId);
              return (
                <li key={it.objectId} data-rally-row onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) { track('rally-button', 'open'); show(it); } }}
                  className={`-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${it.done ? 'opacity-60' : ''} ${open?.objectId === it.objectId ? 'bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-950/50 dark:ring-indigo-800' : ''}`}>
                  <span className="w-7 shrink-0 rounded px-1 text-center text-[10px] font-bold text-white" style={{ background: colorOf(it.kind) }}>{it.kind}</span>
                  <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-0.5 truncate font-mono text-xs text-indigo-600 hover:underline" style={{ width: widths.id }} title="Abrir en Rally">
                    {it.id}<ExternalLink className="size-3" />
                  </a>
                  {/* Columnas fijas (ID, Owner, Estado) para que cuadren con la cabecera; lo secundario va debajo del nombre. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cols.wrap ? 'break-words' : 'truncate'} title={it.name}>{it.name}</span>
                    {(() => {
                      const showAssignee = cols.assignee && groupBy !== 'assignee' && it.assignee && it.assignee !== it.owner;
                      const showTags = cols.tags && groupBy !== 'tag' && it.tags.length > 0;
                      const showProject = cols.project && !projectMode && it.project;
                      const showIteration = cols.iteration && groupBy !== 'iteration' && it.iteration;
                      if (!showAssignee && !showTags && !showProject && !showIteration) return null;
                      return (
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
                          {showAssignee && (
                            <span className={it.mine ? 'font-semibold text-indigo-600 dark:text-indigo-400' : ''} title={`Assignee en Rally: ${it.assignee}`}>→ {it.mine ? 'Tú' : it.assignee}</span>
                          )}
                          {showProject && <span title="Proyecto en Rally">{it.project}</span>}
                          {showIteration && <span title="Iteración">{it.iteration}</span>}
                          {showTags && it.tags.map((t) => (
                            <span key={t} className={`rounded px-1.5 text-[11px] ${tags.some((x) => x.name === t) ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>{t}</span>
                          ))}
                        </span>
                      );
                    })()}
                  </span>
                  {cols.owner && (
                    <span className="hidden shrink-0 items-center gap-1.5 pl-1 text-xs text-zinc-600 md:inline-flex dark:text-zinc-300" style={{ width: widths.owner }} title="Owner en Rally">
                      {it.owner ? <><Avatar name={it.owner} size={18} /><span className="truncate">{it.owner}</span></> : <span className="text-zinc-400">Sin owner</span>}
                    </span>
                  )}
                  {cols.state && <span className="flex shrink-0 justify-end" style={{ width: widths.state }}>
                    {(() => {
                      // El estado con el nombre de la columna del Tablero (así se busca igual en los dos sitios).
                      const col = boardColumnOf(it);
                      const color = RALLY_COLUMNS.find((c) => c.name === col)?.color;
                      const flagged = it.blocked && col !== 'Blocked';
                      return (
                        <span className={`inline-flex items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs ${flagged ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}`}
                          title={`En Rally: ${it.state || '—'}${it.blocked ? ' · Blocked' : ''}`}>
                          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                          {flagged ? `Bloqueada · ${col}` : col}
                        </span>
                      );
                    })()}
                  </span>}
                  {task ? (
                    <button type="button" onClick={() => openTask(task)} className="w-24 shrink-0 rounded-md px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950">
                      {task.status === 'done' ? '✓ Hecha aquí' : 'En el gestor'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void add([it])} className="inline-flex w-24 shrink-0 items-center justify-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                      <Plus className="size-3" />Añadir
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
      </div>

      {open && (
        <RallyDetailPanel
          item={open}
          task={linkedTask(open, byId)}
          color={colorOf(open.kind)}
          onSelect={setOpen}
          onAdd={() => void add([open])}
          onOpenTask={() => { const t = linkedTask(open, byId); if (t) openTask(t); }}
          onClose={closePanel}
        />
      )}
    </div>
    </>
  );
}

/**
 * Buscador de la pantalla Rally: lo escrito filtra la lista de debajo (ID, nombre, personas, proyecto, etiquetas) y, desde
 * dos letras, busca también en todo Rally por ID exacto o palabra del nombre (US, DE, TS, TA, DS y features), por si no está
 * entre lo cargado. Pulsar un resultado abre su ficha.
 */
function RallySearch({ value, onChange, shown, onOpen }: { value: string; onChange: (v: string) => void; shown: number; onOpen: (it: RallyItem) => void }) {
  const [found, setFound] = useState<{ items: RallyPick[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // Los resultados de todo Rally se despliegan debajo del cuadro; se cierran al pulsar fuera (lo escrito sigue filtrando).
  const [panel, setPanel] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const term = value.trim();
  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setPanel(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [panel]);
  useEffect(() => {
    if (term.length < 2) { setFound(null); setError(null); return; }
    let live = true;
    setFound(null);
    setError(null);
    const t = setTimeout(() => {
      rallyApi.pick({ types: ['US', 'DE', 'TS', 'TA', 'DS', 'F'], q: term, project: '', release: '', page: 1 })
        .then((r) => live && setFound(r), (e: Error) => live && setError(e.message));
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  const openPick = async (p: RallyPick) => {
    setOpening(p.id);
    setError(null);
    try {
      const [it] = await rallyApi.lookup([p.id]);
      if (it) { onOpen(it); setPanel(false); } else setError(`No se ha podido abrir ${p.id}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(null);
    }
  };
  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
      <input value={value} onChange={(e) => { onChange(e.target.value); setPanel(true); }} onFocus={() => setPanel(true)}
        placeholder="Buscar por ID o nombre…" aria-label="Buscar en Rally"
        onKeyDown={(e) => { if (e.key === 'Escape') { onChange(''); setPanel(false); } }}
        className="w-72 rounded-full border border-zinc-300 bg-white py-1 pr-8 pl-8 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600 dark:bg-zinc-900" />
      {value && (
        <button type="button" onClick={() => { onChange(''); setPanel(false); }} title="Borrar la búsqueda" aria-label="Borrar la búsqueda"
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="size-4" /></button>
      )}
      {panel && term.length >= 2 && (
        <div className="absolute top-full right-0 z-30 mt-1 w-[32rem] max-w-[90vw] rounded-lg border border-zinc-200 bg-white p-2 text-left text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-1 text-xs text-zinc-500">
            {shown} en la lista · En todo Rally{found ? `: ${found.total}${found.total > found.items.length ? ` (los ${found.items.length} más recientes)` : ''}` : ''}
          </p>
          {found === null && !error && <p className="text-xs text-zinc-400">Buscando en Rally…</p>}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {found && !found.items.length && <p className="text-xs text-zinc-400">Nada en Rally con eso.</p>}
          {found && found.items.length > 0 && (
            <ul className="max-h-80 overflow-y-auto">
              {found.items.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => void openPick(p)} disabled={!!opening}
                    className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-100 disabled:opacity-60 dark:hover:bg-zinc-800">
                    <span className="w-24 shrink-0 font-mono text-xs text-indigo-600">{p.id}</span>
                    <span className="min-w-0 flex-1">{p.name}{p.project && <span className="block text-xs text-zinc-400">{p.project}</span>}</span>
                    {opening === p.id && <span className="text-xs text-zinc-400">Abriendo…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
