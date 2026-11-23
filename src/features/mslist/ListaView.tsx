import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Copy, ExternalLink, ListChecks, Pencil, Plug, Plus, Puzzle, Search, Settings2, Trash2, X } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { useWideLayout } from '../../app/Layout';
import { ActionButton } from '../../components/TaskList';
import { ProjectOptions } from '../../components/ui/ProjectOptions';
import { inputClass } from '../../components/ui/styles';
import { repo } from '../../data/services';
import {
  categoryOfValue, guessStatusColumn, itemCategory, LIST_CATEGORIES, listColumns, listKey, statusValues, taskFromListItem,
  type MsListConfig,
} from '../../domain/msList';
import { changeKey, itemValue, normalizeListUrl, TITLE_FIELD, type MsListField, type MsListItem } from '../../domain/msListParse';
import { fold } from '../../domain/text';
import type { StateCategory } from '../../domain/types';
import { usePersistentState } from '../../hooks/usePersistentState';
import { track } from '../usage/track';
import { ViewHeader } from '../views/ViewHeader';
import { bookmarkletCode, bookmarkletHref } from './bookmarklet';
import { useExtension } from './extension';
import {
  currentItems, dropChange, extensionOk, forgetLista, isConnected, loadListaConfig, queueChange, saveListaConfig, setListUrl, useLista,
} from './listaStore';
import { applyListStates } from './listaStates';

const STALE_MS = 24 * 60 * 60_000;
const CATEGORY_COLOR: Record<string, string> = {
  todo: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  doing: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  blocked: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
};

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

/**
 * Microsoft List sin Power Automate ni permisos de Microsoft: el marcador «Marea · Lista», pulsado en la página de la
 * lista en SharePoint, la trae aquí y aplica allí los cambios hechos en el gestor (estado y otros campos). Las tareas
 * enlazadas (`LS-<id>`) siguen el estado de su elemento y, al moverlas aquí, el cambio queda pendiente para la lista.
 */
export function ListaView() {
  const lista = useLista();
  const extension = useExtension();
  const [setup, setSetup] = useState(false);
  useWideLayout(true);
  const pending = lista.pending.length;
  // Se vuelve a pintar cada 5 s para que «Conectado» se apague solo si se pierde la conexión.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  const viaExtension = !!extension && extensionOk(lista);
  const connected = viaExtension || isConnected(lista);
  const url = lista.snapshot?.url ?? lista.listUrl;

  return (
    <>
      <ViewHeader
        title={<span className="inline-flex items-center gap-2"><ListChecks className="size-5 text-teal-600" />{lista.snapshot?.title ?? 'Lista'}</span>}
        subtitle={lista.snapshot
          ? <span className="inline-flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
              {viaExtension
                ? 'Sincronizada con la extensión: los cambios se aplican solos y la lista se relee cada 2 minutos, sin tener SharePoint abierto'
                : connected
                  ? 'Conectado con SharePoint: los cambios se aplican solos en unos segundos y la lista se relee cada 2 minutos'
                  : extension && lista.ext.error
                    ? `La extensión no puede sincronizar: ${lista.ext.error}`
                    : extension
                      ? 'Conectando con la extensión…'
                      : 'Sin conectar: instala la extensión «Marea · Lista» (en Conectar) o abre la lista en SharePoint y pulsa el marcador'}
            </span>
          : 'Trae una Microsoft List de SharePoint, sin Power Automate'}
        actions={(lista.snapshot || lista.listUrl) && (
          <>
            {url && (
              /* Ventana con nombre: si la pestaña de SharePoint ya está abierta, se vuelve a ella en vez de abrir otra. */
              <a href={url} target="marea-sharepoint" rel="opener"
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">
                <ExternalLink className="size-4" />Abrir en SharePoint
              </a>
            )}
            <ActionButton icon={<Plug className="size-4" />} onClick={() => setSetup(!setup)}>Conectar</ActionButton>
            <ActionButton icon={<Trash2 className="size-4" />} title="Borra la lista de este navegador (las tareas ya añadidas se quedan)"
              onClick={() => { if (confirm('¿Quitar la lista de este navegador? Las tareas ya añadidas se quedan; los cambios pendientes se pierden.')) forgetLista(); }}>
              Quitar
            </ActionButton>
          </>
        )}
      />
      {lista.snapshot && pending > 0 && !connected && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          {pending === 1 ? '1 cambio esperando' : `${pending} cambios esperando`} para la lista. Se aplicarán solos en cuanto haya conexión: con la
          extensión instalada, o abriendo la lista en SharePoint y pulsando el marcador <b>Marea · Lista</b>.
        </p>
      )}
      {lista.snapshot && pending > 0 && connected && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
          Aplicando {pending === 1 ? '1 cambio' : `${pending} cambios`} en SharePoint…
        </p>
      )}
      {(!lista.snapshot || setup) && (
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <ExtensionSetup />
          <BookmarkletSetup />
        </div>
      )}
      {lista.snapshot && <ListaItems />}
    </>
  );
}

const EXTENSION_ZIP = 'marea-lista-extension.zip';

/** La extensión: instalarla y decirle qué lista sincronizar. */
function ExtensionSetup() {
  const lista = useLista();
  const extension = useExtension();
  const [text, setText] = useState(lista.listUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const step = 'font-semibold text-zinc-800 dark:text-zinc-100';
  const connect = () => {
    const url = normalizeListUrl(text);
    if (!url) { setError('Pega la dirección de la lista tal como sale en el navegador (https://….sharepoint.com/…/Lists/…).'); return; }
    setError(null);
    setText(url);
    setListUrl(url);
    track('lista-connect', 'extension');
  };
  return (
    <section className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/50 p-4 text-sm dark:border-teal-900 dark:bg-teal-950/30">
      <h2 className="flex items-center gap-2 font-semibold">
        <Puzzle className="size-4" />Con la extensión de Chrome <span className="font-normal text-zinc-500">(recomendado: sin tener SharePoint abierto)</span>
      </h2>
      {extension ? (
        <p className="text-emerald-700 dark:text-emerald-300">✓ Extensión «Marea · Lista» instalada (versión {extension}).</p>
      ) : (
        <ol className="list-decimal space-y-1.5 pl-5 text-zinc-600 dark:text-zinc-300">
          <li><a href={`/${EXTENSION_ZIP}`} download className="font-medium text-indigo-600 underline dark:text-indigo-400">Descarga la extensión</a> y
            descomprímela (doble clic en el .zip): queda una carpeta <code>marea-lista</code>. Déjala en un sitio fijo, p. ej. Documentos.</li>
          <li>Abre <code className="rounded bg-white px-1 dark:bg-zinc-800">chrome://extensions</code> (cópialo en la barra de direcciones) y
            activa <span className={step}>Modo de desarrollador</span>, arriba a la derecha.</li>
          <li>Pulsa <span className={step}>Cargar descomprimida</span> y elige la carpeta <code>marea-lista</code>.</li>
          <li>Vuelve aquí y recarga la página.</li>
        </ol>
      )}
      <div>
        <p className="mb-1 text-zinc-600 dark:text-zinc-300"><span className={step}>Dirección de la lista</span>: ábrela en SharePoint y copia la dirección del navegador.</p>
        <div className="flex gap-2">
          <input className={`${inputClass} min-w-0 flex-1 py-1`} value={text} onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') connect(); }} placeholder="https://….sharepoint.com/sites/…/Lists/…" aria-label="Dirección de la lista" />
          <button type="button" onClick={connect} disabled={!extension || !text.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Conectar</button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        {extension && lista.listUrl && lista.ext.error && <p className="mt-1 text-xs text-red-600">{lista.ext.error}</p>}
        {extension && lista.listUrl && !lista.ext.error && !lista.ext.okAt && <p className="mt-1 text-xs text-zinc-500">Leyendo la lista…</p>}
      </div>
      <p className="text-xs text-zinc-500">
        Funciona con Chrome abierto y la sesión de SharePoint iniciada en Chrome. Si SharePoint no deja hacerlo en segundo plano, la extensión
        abre la lista en una pestaña fijada y la usa sin que tengas que tocar nada. Si en <code>chrome://extensions</code> no puedes activar el Modo de
        desarrollador, tu empresa bloquea las extensiones propias: usa el marcador.
      </p>
    </section>
  );
}

function BookmarkletSetup() {
  const ref = useRef<HTMLAnchorElement>(null);
  const app = window.location.origin;
  const [copied, setCopied] = useState(false);
  // React no deja poner un href `javascript:` en JSX: se pone a mano.
  useEffect(() => { ref.current?.setAttribute('href', bookmarkletHref(app)); }, [app]);
  const step = 'font-semibold text-zinc-800 dark:text-zinc-100';
  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-700">
      <h2 className="flex items-center gap-2 font-semibold"><Bookmark className="size-4" />Sin extensión: con un marcador</h2>
      <ol className="list-decimal space-y-2 pl-5 text-zinc-600 dark:text-zinc-300">
        <li>
          <span className={step}>Arrastra este botón a la barra de marcadores</span> (si no la ves: Cmd+Shift+B):{' '}
          <a ref={ref} onClick={(e) => { e.preventDefault(); alert('Arrástralo a la barra de marcadores y púlsalo estando en la lista de SharePoint.'); }}
            className="ml-1 inline-flex cursor-grab items-center gap-1.5 rounded-md bg-[#1B2B4B] px-3 py-1 font-medium text-white shadow">
            <Bookmark className="size-3.5" />Marea · Lista
          </a>
        </li>
        <li><span className={step}>Abre tu lista en SharePoint</span> (la dirección tiene <code>/Lists/…</code>) y pulsa el marcador.</li>
        <li><span className={step}>Deja abierta esa pestaña de SharePoint.</span> Mientras siga abierta, los cambios se aplican solos en unos segundos
          y la lista se relee cada 2 minutos. Si la cierras, vuelve a pulsar el marcador.</li>
      </ol>
      <p className="text-xs text-zinc-500">
        ¿El marcador no hace nada? Copia el código, abre la consola en la página de la lista (Cmd+Option+J), pégalo y pulsa Enter.{' '}
        <button type="button" className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300"
          onClick={() => { void navigator.clipboard.writeText(bookmarkletCode(app)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}>
          <Copy className="size-3" />{copied ? 'Copiado' : 'Copiar el código'}
        </button>
      </p>
      <p className="text-xs text-zinc-500">
        Con los dos (extensión y marcador) se usa tu sesión de SharePoint: no se guarda ninguna contraseña ni se piden permisos. La lista y los
        cambios pendientes se guardan en este navegador ({app.replace(/^https?:\/\//, '')}).
      </p>
    </section>
  );
}

function ListaItems() {
  const { tasks, editTask, projects } = useApp();
  const lista = useLista();
  const snapshot = lista.snapshot!;
  const [config, setConfigState] = useState<MsListConfig>(loadListaConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [q, setQ] = useState('');
  const [valueFilter, setValueFilter] = useState('');
  const [hideDone, setHideDone] = usePersistentState('lista-hide-done', true);
  const [projectId, setProjectId] = usePersistentState('lista-project', '');
  const [openId, setOpenId] = useState<string | null>(null);

  const setConfig = (c: MsListConfig) => { setConfigState(c); saveListaConfig(c); void applyListStates().catch(() => {}); };

  const items = useMemo(() => currentItems(lista), [lista]);
  const statusColumn = config.statusColumn ?? guessStatusColumn(items);
  const effective: MsListConfig = { ...config, statusColumn };
  const columns = listColumns(items);
  const fieldOf = (label: string) => snapshot.fields.find((f) => f.label === label);
  const statusField = statusColumn ? fieldOf(statusColumn) : undefined;
  // Valores posibles: las opciones de la columna (si es de opciones) y si no, los que aparecen.
  const values = statusField?.choices.length ? statusField.choices : statusValues(items, statusColumn);
  const extraColumns = columns.filter((c) => c !== statusColumn).slice(0, 3);
  const pendingIds = new Set(lista.pending.map((c) => c.id));
  const linked = useMemo(() => new Map(tasks.filter((t) => !t.deleted_at && t.external_id).map((t) => [t.external_id!, t])), [tasks]);
  const target = projects.some((p) => p.id === projectId) ? projectId : null;

  // La columna adivinada se guarda en cuanto llega la lista, así la sincronización en segundo plano ya la usa.
  useEffect(() => {
    if (!config.statusColumn && statusColumn) setConfig({ statusColumn, map: config.map });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando cambia la columna propuesta
  }, [statusColumn]);

  const query = fold(q.trim());
  const visible = items.filter((it) => (!hideDone || itemCategory(it, effective) !== 'done')
    && (!valueFilter || (statusColumn && it.fields[statusColumn]) === valueFilter)
    && (!query || fold(`${it.id} ${it.title} ${Object.values(it.fields).join(' ')}`).includes(query)));
  const toAdd = visible.filter((it) => !linked.has(listKey(it.id)));

  const add = async (list: MsListItem[]) => {
    await repo.batch(list.length === 1 ? `${list[0].title} añadida desde la lista` : `${list.length} añadidas desde la lista`, async () => {
      for (const it of list) await repo.createTask(taskFromListItem(it, effective, target, snapshot.title));
    });
    track('lista-add', target ? 'project' : 'inbox', list.length);
    // Que cada tarea nueva quede ya en el estado de su elemento.
    void applyListStates().catch(() => {});
  };

  const changeStatus = (it: MsListItem, value: string) => {
    if (!statusColumn) return;
    queueChange(it.id, statusColumn, value);
    track('lista-change', 'status');
    void applyListStates().catch(() => {});
  };

  const stale = Date.now() - new Date(snapshot.at).getTime() > STALE_MS;
  const open = openId ? items.find((it) => it.id === openId) ?? null : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 dark:border-zinc-600 dark:bg-zinc-900">
          <Search className="size-3.5 text-zinc-400" />
          <input className="w-56 bg-transparent py-1 text-sm outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar…" aria-label="Filtrar la lista" />
        </div>
        {values.length > 0 && (
          <select className={`${inputClass} w-auto py-1`} value={valueFilter} onChange={(e) => setValueFilter(e.target.value)} aria-label="Estado">
            <option value="">Todos los estados</option>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <label className="inline-flex items-center gap-1 text-xs text-zinc-500">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Ocultar terminados
        </label>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className={`text-xs ${stale ? 'font-medium text-amber-600' : 'text-zinc-400'}`} title="Cuándo se pulsó el marcador por última vez">
            Leída {ago(snapshot.at)} · {items.length} elementos{stale ? ' · abre SharePoint y pulsa el marcador para traer lo último' : ''}
          </span>
          <ActionButton icon={<Settings2 className="size-4" />} onClick={() => setShowConfig(!showConfig)}>Estados</ActionButton>
        </span>
      </div>

      {(showConfig || !statusColumn) && (
        <section className="mb-4 rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-sm dark:border-teal-900 dark:bg-teal-950/30">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-medium">Columna de estado</span>
            <select className={`${inputClass} w-56 py-1`} value={statusColumn ?? ''} aria-label="Columna de estado"
              onChange={(e) => setConfig({ statusColumn: e.target.value || null, map: {} })}>
              <option value="">Elige la columna…</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {values.length > 0 && (
            <>
              <p className="mb-1 text-xs text-zinc-500">A qué columna del Tablero corresponde cada valor (para mover las tareas enlazadas en los dos sentidos):</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {values.map((v) => (
                  <label key={v} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={v}>{v}</span>
                    <select className={`${inputClass} w-36 py-0.5 text-xs`} value={categoryOfValue(v, effective)} aria-label={`Categoría de ${v}`}
                      onChange={(e) => setConfig({ statusColumn, map: { ...config.map, [v]: e.target.value as StateCategory } })}>
                      {LIST_CATEGORIES.map((c) => <option key={c.category} value={c.category}>{c.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500">Al mover una tarea en el gestor, se pone en la lista el primer valor de su categoría (en este orden).</p>
            </>
          )}
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
        <span className="text-zinc-500">Pasar a mis tareas del gestor, en</span>
        <select className={`${inputClass} w-48 py-1`} value={target ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-label="Proyecto de destino">
          <option value="">Bandeja (sin proyecto)</option>
          <ProjectOptions />
        </select>
        {toAdd.length > 0 && <ActionButton icon={<Plus className="size-4" />} onClick={() => void add(toAdd)}>Crear {toAdd.length === 1 ? '1 tarea' : `${toAdd.length} tareas`}</ActionButton>}
      </div>

      {visible.length === 0 && <p className="text-sm text-zinc-500">No hay elementos con estos filtros.</p>}

      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[11px] font-semibold tracking-wide text-zinc-400 uppercase dark:border-zinc-700">
                <th className="w-14 py-1 pr-2">ID</th>
                <th className="py-1 pr-2">Título</th>
                {statusColumn && <th className="w-44 py-1 pr-2">{statusColumn}</th>}
                {extraColumns.map((c) => <th key={c} className="hidden max-w-40 py-1 pr-2 lg:table-cell">{c}</th>)}
                <th className="w-28 py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {visible.map((it) => {
                const task = linked.get(listKey(it.id));
                const value = statusColumn ? it.fields[statusColumn] ?? '' : '';
                const category = itemCategory(it, effective);
                const errors = lista.pending.filter((c) => c.id === it.id).map((c) => lista.errors[changeKey(c)]).filter(Boolean);
                return (
                  <tr key={it.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                    <td className="py-1.5 pr-2 font-mono text-xs text-zinc-500">{it.id}</td>
                    <td className="py-1.5 pr-2">
                      <button type="button" onClick={() => setOpenId(it.id)} className="text-left hover:text-indigo-600 hover:underline">{it.title}</button>
                      {pendingIds.has(it.id) && (
                        <span className={`ml-2 text-[11px] ${errors.length ? 'text-red-600' : 'text-amber-600'}`}
                          title={errors.length ? errors.join('\n') : 'Se aplicará en la lista en cuanto haya conexión'}>
                          {errors.length ? 'error al aplicar' : 'pendiente'}
                        </span>
                      )}
                    </td>
                    {statusColumn && (
                      <td className="py-1.5 pr-2">
                        <select value={value} disabled={statusField ? !statusField.editable : false} onChange={(e) => changeStatus(it, e.target.value)} aria-label={`Estado de ${it.title}`}
                          className={`w-full rounded-full border-0 px-2 py-0.5 text-xs ${CATEGORY_COLOR[category] ?? CATEGORY_COLOR.todo}`}>
                          {!value && <option value="">—</option>}
                          {(values.includes(value) || !value ? values : [value, ...values]).map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </td>
                    )}
                    {extraColumns.map((c) => <td key={c} className="hidden max-w-40 truncate py-1.5 pr-2 text-xs text-zinc-500 lg:table-cell" title={it.fields[c]}>{it.fields[c]}</td>)}
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button type="button" onClick={() => setOpenId(it.id)} title="Ver y editar los campos"
                        className="mr-1 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                        <Pencil className="size-3.5" />
                      </button>
                      {task ? (
                        <button type="button" onClick={() => editTask(task)} className="rounded-md px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950">
                          {task.status === 'done' ? '✓ Hecha aquí' : 'En el gestor'}
                        </button>
                      ) : (
                        <button type="button" onClick={() => void add([it])} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                          <Plus className="size-3" />Añadir
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <ItemPanel key={open.id} item={open} original={snapshot.items.find((it) => it.id === open.id) ?? open} fields={snapshot.fields}
        pendingKeys={new Set(lista.pending.filter((c) => c.id === open.id).map(changeKey))} errors={lista.errors} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Ficha de un elemento: todos sus campos; los editables se cambian aquí y quedan pendientes para la lista. */
function ItemPanel({ item, original, fields, pendingKeys, errors, onClose }: {
  item: MsListItem; original: MsListItem; fields: MsListField[]; pendingKeys: Set<string>; errors: Record<string, string>; onClose: () => void;
}) {
  const ordered = [...fields.filter((f) => f.label === TITLE_FIELD), ...fields.filter((f) => f.label !== TITLE_FIELD)];
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(ordered.map((f) => [f.label, itemValue(item, f.label)])));
  const changed = ordered.filter((f) => f.editable && draft[f.label] !== itemValue(item, f.label));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    for (const f of changed) queueChange(item.id, f.label, (draft[f.label] ?? '').trim());
    track('lista-change', 'fields', changed.length);
    void applyListStates().catch(() => {});
    onClose();
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <header className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-zinc-500">Elemento {item.id}</p>
          <h2 className="font-semibold">{item.title}</h2>
        </div>
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer" title="Abrir en SharePoint" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <ExternalLink className="size-4" />
          </a>
        )}
        <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {ordered.map((f) => {
          const key = `${item.id}|${f.label}`;
          const isChanged = f.editable && draft[f.label] !== itemValue(item, f.label);
          const isPending = pendingKeys.has(key);
          return (
            <label key={f.name} className="block">
              <span className="mb-0.5 flex items-center gap-2 text-xs font-medium text-zinc-500">
                {f.label}
                {!f.editable && <span className="font-normal text-zinc-400">(solo lectura)</span>}
                {isPending && !isChanged && (
                  <span className={`font-normal ${errors[key] ? 'text-red-600' : 'text-amber-600'}`} title={errors[key] ?? `En la lista: ${itemValue(original, f.label) || '—'}`}>
                    {errors[key] ? `error: ${errors[key]}` : 'pendiente'}
                    <button type="button" onClick={(e) => { e.preventDefault(); dropChange(key); setDraft({ ...draft, [f.label]: itemValue(original, f.label) }); }}
                      className="ml-1 underline">deshacer</button>
                  </span>
                )}
              </span>
              <FieldInput field={f} value={draft[f.label] ?? ''} changed={isChanged} onChange={(v) => setDraft({ ...draft, [f.label]: v })} />
            </label>
          );
        })}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
        <span className="mr-auto text-xs text-zinc-500">Se aplica en la lista en unos segundos si hay conexión.</span>
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
        <button type="button" disabled={!changed.length} onClick={save}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          Guardar {changed.length ? `(${changed.length})` : ''}
        </button>
      </footer>
    </aside>
  );
}

function FieldInput({ field: f, value, changed, onChange }: { field: MsListField; value: string; changed: boolean; onChange: (v: string) => void }) {
  const cls = `${inputClass} py-1 ${changed ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/40' : ''}`;
  if (!f.editable) return <p className="rounded-md bg-zinc-50 px-2 py-1 whitespace-pre-wrap text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{value || '—'}</p>;
  if (f.type === 'Choice') {
    const options = f.choices.includes(value) || !value ? f.choices : [value, ...f.choices];
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  if (f.type === 'MultiChoice') {
    const chosen = value ? value.split(/\s*,\s*/) : [];
    return (
      <div className={`${cls} flex flex-wrap gap-x-3 gap-y-1`}>
        {f.choices.map((c) => (
          <span key={c} className="inline-flex items-center gap-1">
            <input type="checkbox" checked={chosen.includes(c)}
              onChange={(e) => onChange((e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c)).filter((x) => f.choices.includes(x)).sort((a, b) => f.choices.indexOf(a) - f.choices.indexOf(b)).join(', '))} />
            {c}
          </span>
        ))}
      </div>
    );
  }
  if (f.type === 'Boolean') {
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option><option value="Sí">Sí</option><option value="No">No</option>
      </select>
    );
  }
  if (f.type === 'DateTime') {
    return f.format === 'datetime'
      ? <input type="datetime-local" className={cls} value={value.replace(' ', 'T')} onChange={(e) => onChange(e.target.value.replace('T', ' '))} />
      : <input type="date" className={cls} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (f.type === 'Number' || f.type === 'Currency') return <input type="number" step="any" className={cls} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'Note') return <textarea rows={4} className={`${cls} resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />;
  return <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} />;
}
