import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Layers, Pin, Plus, RefreshCw, Search, Unplug, Wand2, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { ActionButton, Section } from '../../components/TaskList';
import { Avatar } from '../../components/ui/Badges';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import {
  boardColumnOf, groupRally, linkedTask, RALLY_COLUMNS, RALLY_KINDS, taskFromRally, tasksByRallyId,
  type RallyGroupBy, type RallyItem, type RallyKind, type RallyProject, type RallyRef, type RallyStatus,
} from '../../domain/rally';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { Task } from '../../domain/types';
import { fold } from '../../domain/text';
import { useWideLayout } from '../../app/Layout';
import { ViewHeader } from '../views/ViewHeader';
import { RallyCreateForm, type RallyPrefill } from './RallyCreateForm';
import { RallyRequestDialog } from './RallyRequestDialog';
import { RallyDetailPanel } from './RallyDetailPanel';
import { rallyApi } from './rallyApi';
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
      <ViewHeader
        title={<span className="inline-flex items-center gap-2"><Layers className="size-5 text-indigo-500" />Rally</span>}
        subtitle={status?.connected ? `Conectado como ${status.rallyUser}` : 'Conecta tu cuenta de Rally con una clave de API'}
        actions={status?.connected && (
          <ActionButton icon={<Unplug className="size-4" />} title="Borra la clave del servidor"
            onClick={() => { if (confirm('¿Desconectar Rally? Se borra tu clave del servidor. Las tareas ya añadidas se quedan.')) void rallyApi.disconnect().then(setStatus); }}>
            Desconectar
          </ActionButton>
        )}
      />
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {status && (status.connected ? <RallyItems /> : <ConnectForm initialUrl={status.baseUrl} onConnected={setStatus} />)}
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

const chipClass = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-xs font-medium ${on
  ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'}`;

const NO_ONE = '__nadie';
/** Proyectos que se ven de entrada (además de los fijados y los elegidos); el resto, con el buscador. */
const SHOWN_PROJECTS = 10;

/**
 * Proyectos de Rally como chips: primero los fijados, después los elegidos y hasta 10 en total con el resto (por
 * nombre). Un buscador encuentra cualquier otro; el alfiler fija o suelta (se recuerda en este navegador).
 */
function ProjectChips({ projects, selected, onToggle, pinned, onPin }: {
  projects: RallyProject[];
  selected: string[];
  onToggle: (id: string) => void;
  pinned: string[];
  onPin: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // La lista de resultados se cierra al pulsar fuera de ella (o con Esc).
  useEffect(() => {
    if (!q) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setQ(''); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setQ(''); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [q]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const first = [...new Set([...pinned, ...selected])].map((id) => byId.get(id)).filter((p): p is RallyProject => !!p);
  const rest = projects.filter((p) => !first.includes(p)).slice(0, Math.max(0, SHOWN_PROJECTS - first.length));
  const shown = [...first, ...rest];
  const hidden = projects.length - shown.length;
  const query = fold(q.trim());
  const matches = query ? projects.filter((p) => fold(p.name).includes(query)).slice(0, 30) : [];

  const pinButton = (p: RallyProject, on: boolean) => (
    <button type="button" onClick={() => onPin(p.id)} title={on ? 'Soltar (deja de salir arriba)' : 'Fijar arriba'} aria-label={on ? `Soltar ${p.name}` : `Fijar ${p.name}`}
      className={`rounded p-0.5 ${on ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'}`}>
      <Pin className={`size-3.5 ${on ? 'fill-current' : ''}`} />
    </button>
  );

  return (
    <>
      {shown.map((p) => {
        const on = selected.includes(p.id);
        const isPinned = pinned.includes(p.id);
        return (
          <span key={p.id} className={`group inline-flex items-center gap-0.5 rounded-full border pr-1 ${on
            ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300'}`}>
            <button type="button" onClick={() => onToggle(p.id)} className="py-0.5 pl-2.5 text-xs font-medium">{p.name}</button>
            <span className={isPinned ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}>
              <button type="button" onClick={() => onPin(p.id)} title={isPinned ? 'Soltar (deja de salir arriba)' : 'Fijar arriba'}
                aria-label={isPinned ? `Soltar ${p.name}` : `Fijar ${p.name}`}
                className={`rounded p-0.5 ${on ? 'text-white' : isPinned ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'}`}>
                <Pin className={`size-3 ${isPinned ? 'fill-current' : ''}`} />
              </button>
            </span>
          </span>
        );
      })}
      <div ref={box} className="relative">
        <div className="flex items-center gap-1.5 rounded-full border-2 border-indigo-400 bg-white px-3 shadow-sm focus-within:border-indigo-600 focus-within:ring-2 focus-within:ring-indigo-200 dark:border-indigo-500 dark:bg-zinc-900 dark:focus-within:ring-indigo-900">
          <Search className="size-4 text-indigo-600 dark:text-indigo-400" />
          <input className="w-64 bg-transparent py-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-500 dark:text-zinc-100 dark:placeholder:text-zinc-400" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={hidden > 0 ? `Buscar entre ${projects.length} proyectos…` : 'Buscar proyecto…'} aria-label="Buscar proyecto de Rally" />
          {q && <button type="button" onClick={() => setQ('')} aria-label="Borrar búsqueda"><X className="size-4 text-zinc-400 hover:text-zinc-700" /></button>}
        </div>
        {query && (
          <div className="absolute top-full left-0 z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            {matches.length === 0 && <p className="px-2 py-1 text-xs text-zinc-400">Ningún proyecto con ese nombre.</p>}
            {matches.map((p) => {
              const on = selected.includes(p.id);
              return (
                <div key={p.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={on} onChange={() => onToggle(p.id)} />
                    <span className="truncate" title={p.name}>{p.name}</span>
                  </label>
                  {pinButton(p, pinned.includes(p.id))}
                </div>
              );
            })}
            <p className="border-t border-zinc-100 px-2 pt-1 text-[11px] text-zinc-400 dark:border-zinc-800">Marca para verlo; con el alfiler sale siempre arriba.</p>
          </div>
        )}
      </div>
    </>
  );
}
const GROUP_LABEL: Record<RallyGroupBy, string> = { column: 'estado del tablero', category: 'categoría', state: 'estado exacto de Rally', iteration: 'iteración', assignee: 'persona', tag: 'etiqueta' };
const NO_GROUP: Partial<Record<RallyGroupBy, string>> = { iteration: 'Sin iteración', assignee: 'Sin asignar', tag: 'Sin etiqueta' };

function RallyItems() {
  const { tasks, itemTypes, projects, editTask, closeDetail } = useApp();
  const [rallyProjects, setRallyProjects] = useState<RallyProject[] | null>(null);
  const [items, setItems] = useState<RallyItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  // Tipos con más elementos de los que se traen (5.000 por tipo): se avisa para acotar.
  const [truncated, setTruncated] = useState<{ kind: RallyKind; total: number; shown: number }[]>([]);
  const [selected, setSelected] = usePersistentState<string[]>('rally-projects', []);
  const [pinned, setPinned] = usePersistentState<string[]>('rally-pinned-projects', []);
  // Filtro por etiquetas de Rally: los test sets no tienen Assignee y se reparten por etiqueta.
  const [tags, setTags] = usePersistentState<RallyRef[]>('rally-tag-filter', []);
  const [kinds, setKinds] = usePersistentState<RallyKind[]>('rally-kinds', RALLY_KINDS.map((k) => k.kind));
  const [hideDone, setHideDone] = usePersistentState('rally-hide-done', false);
  const [onlyMine, setOnlyMine] = usePersistentState('rally-only-mine', false);
  const [person, setPerson] = useState('');
  const [groupBy, setGroupBy] = usePersistentState<RallyGroupBy>('rally-group-by-v2', 'column');
  const [days, setDays] = usePersistentState('rally-days-v2', 0);
  const [projectId, setProjectId] = usePersistentState('rally-project', '');
  // Elemento abierto en el panel de la derecha.
  const [open, setOpen] = useState<RallyItem | null>(null);
  const [creating, setCreating] = useState(false);
  // «Crear con petición»: la frase y, ya interpretada, el formulario relleno.
  const [asking, setAsking] = useState(false);
  const [prefill, setPrefill] = useState<RallyPrefill | null>(null);
  const closePanel = useCallback(() => setOpen(null), []);
  // Con el panel abierto, la vista usa todo el ancho y el panel es una columna más (como en el Tablero).
  useWideLayout(!!open);

  useEffect(() => {
    rallyApi.projects().then(setRallyProjects, (e: Error) => setError(e.message));
  }, []);

  // Proyectos elegidos que siguen existiendo (en una cadena, para no recargar en cada render).
  const projectKey = rallyProjects ? selected.filter((id) => rallyProjects.some((p) => p.id === id)).join(',') : null;
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
      const { items: loaded, truncated: cut } = await rallyApi.items(days, projectKey ? projectKey.split(',') : [], tagKey ? tagKey.split('\n') : []);
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
  }, [days, projectKey, tagKey]);

  useEffect(() => {
    setItems(null);
    setPerson('');
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const byId = useMemo(() => tasksByRallyId(tasks), [tasks]);
  const base = (items ?? []).filter((it) => (!hideDone || !it.done) && (!browsing || !onlyMine || it.mine)
    && (!person || (person === NO_ONE ? !it.assignee : it.assignee === person)));
  const visible = base.filter((it) => kinds.includes(it.kind));
  const people = [...new Set((items ?? []).map((it) => it.assignee).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b, 'es'));
  const toAdd = visible.filter((it) => !it.done && !linkedTask(it, byId));
  const target = projects.some((p) => p.id === projectId) ? projectId : null;

  const colorOf = (kind: RallyKind) => itemTypes.find((t) => t.short && t.short.toUpperCase() === kind)?.color ?? '#71717a';
  const show = (it: RallyItem) => { closeDetail(); setOpen(it); };
  const openTask = (task: Task) => { setOpen(null); editTask(task); };
  const toggleProject = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  // «Create + New» deja el formulario abierto: el nuevo se suma a la lista sin abrir su ficha.
  const created = (it: RallyItem, addToGestor: boolean, keepOpen: boolean) => {
    if (!keepOpen) { setCreating(false); setPrefill(null); }
    setItems((list) => [it, ...(list ?? []).filter((x) => x.objectId !== it.objectId)]);
    if (addToGestor) void add([it]);
    if (!keepOpen) show(it);
  };
  const add = (list: RallyItem[]) => repo.batch(list.length === 1 ? `${list[0].id} añadida desde Rally` : `${list.length} añadidas desde Rally`, async () => {
    for (const it of list) await repo.createTask(taskFromRally(it, itemTypes, target));
  });

  return (
    <div className={open ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_460px] xl:items-start xl:gap-6' : ''}>
      <div className="min-w-0">
      <section className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/40">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-indigo-700 uppercase dark:text-indigo-300">Qué ver de Rally</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={chipClass(!browsing)} onClick={() => { setSelected([]); setTags([]); }} title="Lo que tiene Assignee u Owner = tú">Asignado a mí</button>
          {rallyProjects && (
            <ProjectChips projects={rallyProjects} selected={selected} onToggle={toggleProject} pinned={pinned}
              onPin={(id) => setPinned(pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id])} />
          )}
          {rallyProjects === null && <span className="text-xs text-zinc-400">Cargando proyectos…</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">Etiquetas</span>
          <div className="w-full max-w-md">
            <ValuesField title="Filtrar por etiquetas" value={tags} onChange={setTags} load={rallyApi.tags} recentKey="rally-recent-tags" />
          </div>
          <span className="text-xs text-zinc-500">
            {tagKey ? `Lo que tenga ${tags.length > 1 ? 'alguna de estas etiquetas' : 'esta etiqueta'}, ${projectMode ? 'en los proyectos elegidos' : 'en todo Rally'}.`
              : 'Para los TS, que se reparten por etiqueta (no tienen Assignee).'}
          </span>
        </div>
        {browsing && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Solo lo mío
            </label>
            <select className={`${inputClass} w-56 py-1`} value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Persona" disabled={onlyMine}>
              <option value="">Todas las personas</option>
              {people.map((name) => <option key={name} value={name}>{name}</option>)}
              <option value={NO_ONE}>Sin asignar</option>
            </select>
          </div>
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {RALLY_KINDS.map(({ kind, label }) => {
          const on = kinds.includes(kind);
          return (
            <button key={kind} type="button" title={label} onClick={() => setKinds(on ? kinds.filter((k) => k !== kind) : [...kinds, kind])}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${on ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'border-zinc-300 text-zinc-500 dark:border-zinc-600'}`}>
              {kind} · {base.filter((it) => it.kind === kind).length}
            </button>
          );
        })}
        <label className="ml-1 inline-flex items-center gap-1 text-xs text-zinc-500">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Ocultar terminadas
        </label>
        <select className={`${inputClass} w-auto py-0.5 text-xs`} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Periodo">
          <option value={30}>Últimos 30 días</option>
          <option value={90}>Últimos 90 días</option>
          <option value={365}>Último año</option>
          <option value={0}>Todo</option>
        </select>
        <select className={`${inputClass} w-auto py-0.5 text-xs`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as RallyGroupBy)} aria-label="Agrupar por">
          {(Object.keys(GROUP_LABEL) as RallyGroupBy[]).map((g) => <option key={g} value={g}>Agrupar por {GROUP_LABEL[g]}</option>)}
        </select>
        <span className="ml-auto inline-flex items-center gap-2">
          {loadedAt && <span className="text-xs text-zinc-400">Actualizado {loadedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span>}
          <ActionButton icon={<Plus className="size-4" />} onClick={() => { setPrefill(null); setCreating(!!rallyProjects); }}>Nuevo en Rally</ActionButton>
          <ActionButton icon={<Wand2 className="size-4" />} onClick={() => setAsking(!!rallyProjects)}>Crear con petición</ActionButton>
          <ActionButton icon={<RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />} onClick={() => void load()}>Actualizar</ActionButton>
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
        <span className="text-zinc-500">Añadir al gestor en</span>
        <select className={`${inputClass} w-48 py-1`} value={target ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Proyecto de destino">
          <option value="">Bandeja (sin proyecto)</option>
          <ProjectOptions />
        </select>
        {toAdd.length > 0 && <ActionButton icon={<Plus className="size-4" />} onClick={() => void add(toAdd)}>Añadir las {toAdd.length} pendientes que se ven</ActionButton>}
        <span className="text-xs text-zinc-400">Las tareas añadidas se mueven solas a la categoría que tengan en Rally.</span>
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
          más recientes). Acota con el periodo, las etiquetas o menos proyectos.
        </p>
      )}
      {items === null && !error && <p className="text-sm text-zinc-500">Cargando de Rally…</p>}
      {items !== null && visible.length === 0 && (
        <p className="text-sm text-zinc-500">
          {tagKey ? 'No hay nada con estas etiquetas y estos filtros. Prueba con el periodo «Todo».' : projectMode ? 'No hay nada en estos proyectos con estos filtros.' : 'No hay nada asignado a ti (Assignee u Owner) con estos filtros. Prueba con el periodo «Todo» o elige un proyecto arriba.'}
        </p>
      )}

      {visible.length > 0 && (
        <div className="-mx-2 mb-1 hidden gap-2 border-b border-zinc-200 px-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase md:flex dark:border-zinc-700">
          <span className="w-7" /><span className="w-24">ID</span><span className="flex-1">Name</span><span className="w-40">Owner</span>
          <span className="w-36 text-right">Estado</span><span className="w-24" />
        </div>
      )}
      {groupRally(visible, groupBy).map((g) => (
        <Section key={g.key ?? '-'} collapsible title={`${g.key ?? NO_GROUP[groupBy] ?? 'Sin asignar'} · ${g.items.length}`}>
          {g.items.length === 0 && <p className="py-1 text-xs text-zinc-400">Nada en esta categoría.</p>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {g.items.map((it) => {
              const task = linkedTask(it, byId);
              return (
                <li key={it.objectId} data-rally-row onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) show(it); }}
                  className={`-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${it.done ? 'opacity-60' : ''} ${open?.objectId === it.objectId ? 'bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-950/50 dark:ring-indigo-800' : ''}`}>
                  <span className="w-7 shrink-0 rounded px-1 text-center text-[10px] font-bold text-white" style={{ background: colorOf(it.kind) }}>{it.kind}</span>
                  <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex w-24 shrink-0 items-center gap-0.5 font-mono text-xs text-indigo-600 hover:underline" title="Abrir en Rally">
                    {it.id}<ExternalLink className="size-3" />
                  </a>
                  {/* Columnas fijas (ID, Owner, Estado) para que cuadren con la cabecera; lo variable va junto al nombre. */}
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="min-w-0 truncate" title={it.name}>{it.name}</span>
                    {groupBy !== 'assignee' && it.assignee && it.assignee !== it.owner && (
                      <span className={`hidden max-w-32 shrink-0 truncate text-xs md:inline ${it.mine ? 'font-semibold text-indigo-600 dark:text-indigo-400' : 'text-zinc-400'}`} title={`Assignee en Rally: ${it.assignee}`}>
                        → {it.mine ? 'Tú' : it.assignee}
                      </span>
                    )}
                    {groupBy !== 'tag' && it.tags.slice(0, 2).map((t) => (
                      <span key={t} className={`hidden max-w-28 shrink-0 truncate rounded px-1.5 text-[11px] 2xl:inline ${tags.some((x) => x.name === t) ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`} title={it.tags.join(', ')}>{t}</span>
                    ))}
                    {groupBy !== 'tag' && it.tags.length > 2 && <span className="hidden shrink-0 text-[11px] text-zinc-400 2xl:inline" title={it.tags.join(', ')}>+{it.tags.length - 2}</span>}
                    {!projectMode && it.project && <span className="hidden max-w-40 shrink-0 truncate text-xs text-zinc-400 lg:inline" title={it.project}>{it.project}</span>}
                  </span>
                  <span className="hidden w-40 shrink-0 items-center gap-1.5 text-xs text-zinc-600 md:inline-flex dark:text-zinc-300" title="Owner en Rally">
                    {it.owner ? <><Avatar name={it.owner} size={18} /><span className="truncate">{it.owner}</span></> : <span className="text-zinc-400">Sin owner</span>}
                  </span>
                  <span className="flex w-36 shrink-0 justify-end">
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
                  </span>
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
  );
}
