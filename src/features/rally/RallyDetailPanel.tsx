import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Paperclip, Trash2, Plus, Send, Upload, X } from 'lucide-react';
import type { RallyDetail, RallyItem } from '../../domain/rally';
import type { Task } from '../../domain/types';
import { MAX_UPLOAD, rallyApi, toBase64, tooBigMessage } from './rallyApi';
import { RallyFlags } from './RallyFlags';

/** Campos que se ven primero (con el nombre que les da Rally); el resto va en "Más campos". */
const PRIMARY = [
  'Assignee', 'Owner', 'Flow State', 'Schedule State', 'State', 'Iteration', 'Release', 'Project', 'Priority', 'Severity',
  'Environment', 'Tipo', 'Type', 'Canal', 'Servicio IT', 'APPGAR', 'Plan Estimate', 'Requirement', 'Work Product', 'Parent',
  'Feature', 'Resolution', 'Afectación a usuario', 'Propagado a producción', 'Last Verdict', 'Method',
];

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Fields({ fields }: { fields: RallyDetail['fields'] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1 text-sm">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="truncate text-zinc-500" title={f.label}>{f.label}</dt>
          <dd className="break-words">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Ficha de un elemento de Rally en un panel a la derecha (como el de las tareas del Tablero): todos sus campos, textos, etiquetas,
 * elementos relacionados, discusión y adjuntos. Solo lectura; los relacionados se abren en el mismo panel.
 */
export function RallyDetailPanel({ item, task, color, onSelect, onAdd, onOpenTask, onClose }: {
  item: RallyItem;
  task: Task | undefined;
  color: string;
  onSelect: (item: RallyItem) => void;
  onAdd: () => void;
  onOpenTask: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RallyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    rallyApi.detail(item).then((d) => { if (alive) setDetail(d); }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [item]);

  // Se cierra con Esc o con un clic fuera (salvo en otra fila de Rally, que abre esa, o en un desplegable).
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!ref.current?.contains(target) && !target.closest('[data-rally-row], [data-popover]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const current = detail?.item ?? item;
  // Tras Ready/Blocked: se ve al momento y se vuelve a leer la ficha (motivo y comentario nuevos) sin vaciarla.
  const flagged = (updated: RallyItem) => {
    setDetail((d) => (d ? { ...d, item: updated } : d));
    rallyApi.detail(updated).then(setDetail, () => {});
  };

  return (
    // En pantallas anchas es una columna junto a la lista (fija al hacer scroll); en las estrechas se superpone por la derecha.
    <aside ref={ref} className="fixed inset-y-0 right-0 z-30 flex w-[460px] max-w-full flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 xl:sticky xl:top-0 xl:z-auto xl:max-h-[calc(100dvh-3rem)] xl:w-auto xl:rounded-lg xl:border xl:shadow-sm">
      <header className="flex items-center gap-2 px-4 pt-3">
        <span className="rounded px-1 text-[10px] font-bold text-white" style={{ background: color }}>{current.kind}</span>
        <a href={current.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-sm text-indigo-600 hover:underline">
          {current.id}<ExternalLink className="size-3.5" />
        </a>
        <span className="text-xs text-zinc-400">Abrir en Rally</span>
        <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Cerrar">
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pt-2 pb-3">
          <h2 className="text-lg leading-snug font-semibold">{current.name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">{current.state}</span>
            {current.done && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Terminada</span>}
            {current.assignee && <span className="text-zinc-500">Assignee: <b className={current.mine ? 'text-indigo-600 dark:text-indigo-400' : ''}>{current.mine ? 'Tú' : current.assignee}</b></span>}
            <span className="ml-auto">
              {task ? (
                <button type="button" onClick={onOpenTask} className="rounded-md px-2 py-0.5 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950">
                  {task.status === 'done' ? '✓ Hecha en el gestor' : 'Abrir en el gestor'}
                </button>
              ) : (
                <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800">
                  <Plus className="size-3" />Añadir al gestor
                </button>
              )}
            </span>
          </div>
          <RallyFlags item={current} task={task?.external_id === current.id ? task : undefined} reason={detail?.blockedReason ?? null} onChanged={flagged} />
        </div>

        <RallyDetailBody item={current} detail={detail} error={error} onSelect={onSelect} />
      </div>
    </aside>
  );
}

/** Contenido de la ficha (detalles, etiquetas, textos, relacionados, discusión y adjuntos): panel de Rally y de la tarea. */
export function RallyDetailBody({ item: current, detail, error, onSelect }: {
  item: RallyItem;
  detail: RallyDetail | null;
  error: string | null;
  onSelect: (item: RallyItem) => void;
}) {
  const primary = (detail?.fields ?? []).filter((f) => PRIMARY.includes(f.label))
    .sort((a, b) => PRIMARY.indexOf(a.label) - PRIMARY.indexOf(b.label));
  const rest = (detail?.fields ?? []).filter((f) => !PRIMARY.includes(f.label));
  return (
    <>
      {error && <p className="mx-4 mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {!detail && !error && <p className="px-4 pb-3 text-sm text-zinc-500">Cargando la ficha de Rally…</p>}

      {detail && (
        <>
          {primary.length > 0 && (
            <Block title="Detalles">
              <Fields fields={primary} />
              {rest.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Más campos · {rest.length}</summary>
                  <div className="mt-2"><Fields fields={rest} /></div>
                </details>
              )}
            </Block>
          )}
          {detail.tags.length > 0 && (
            <Block title="Etiquetas">
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((t) => <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">{t}</span>)}
              </div>
            </Block>
          )}
          {detail.texts.map((t) => (
            <Block key={t.label} title={t.label}>
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{t.text}</p>
            </Block>
          ))}
          {detail.related.map((g) => (
            <Block key={g.label} title={`${g.label} · ${g.items.length}`}>
              <ul className="space-y-1">
                {g.items.map((r) => (
                  <li key={r.objectId}>
                    <button type="button" onClick={() => onSelect(r)} className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${r.done ? 'opacity-60' : ''}`}>
                      <span className="shrink-0 font-mono text-xs text-indigo-600">{r.id}</span>
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{r.mine ? 'Tú' : r.assignee}</span>
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">{r.state}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Block>
          ))}
          {(current.kind === 'US' || current.kind === 'DE') && <NewRallyTask key={`new-${current.objectId}`} parent={current} onSelect={onSelect} />}
          <Discussion key={current.objectId} item={current} posts={detail.discussion} />
          <Attachments key={`files-${current.objectId}`} item={current} files={detail.attachments} />
        </>
      )}
    </>
  );
}

/** Alta rápida de tareas de Rally dentro de una US o un defecto. Las creadas se listan debajo (se abren en la ficha). */
function NewRallyTask({ parent, onSelect }: { parent: RallyItem; onSelect: (item: RallyItem) => void }) {
  const [added, setAdded] = useState<RallyItem[]>([]);
  const [name, setName] = useState('');
  const [assignToMe, setAssignToMe] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const item = await rallyApi.create({ kind: 'TA', name, parentId: parent.id, assignToMe });
      setAdded((list) => [...list, item]);
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Block title={`Nueva tarea en ${parent.id}`}>
      {added.length > 0 && (
        <ul className="mb-2 space-y-1">
          {added.map((r) => (
            <li key={r.objectId}>
              <button type="button" onClick={() => onSelect(r)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
                <span className="shrink-0 font-mono text-xs text-indigo-600">{r.id}</span>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="shrink-0 text-xs text-emerald-600">Creada</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre de la tarea…"
          maxLength={256}
          disabled={sending}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-400 disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900"
        />
        <button type="submit" disabled={!name.trim() || sending}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
          <Plus className="size-3" />{sending ? 'Creando…' : 'Crear'}
        </button>
      </form>
      <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-zinc-500">
        <input type="checkbox" checked={assignToMe} onChange={(e) => setAssignToMe(e.target.checked)} /> Asignármela
      </label>
      {error && <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
    </Block>
  );
}

/** Discusión de Rally con una casilla para publicar (Cmd/Ctrl+Enter). Lo publicado se añade al final sin recargar la ficha. */
function Discussion({ item, posts }: { item: RallyItem; posts: RallyDetail['discussion'] }) {
  const [added, setAdded] = useState<RallyDetail['discussion']>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = [...posts, ...added];

  const publish = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const post = await rallyApi.comment(item, text);
      setAdded((list) => [...list, post]);
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Block title={`Discusión · ${all.length}`}>
      {all.length > 0 && (
        <ul className="mb-3 space-y-3">
          {all.map((p, i) => (
            <li key={i} className="text-sm">
              <div className="text-xs text-zinc-500"><b className="text-zinc-700 dark:text-zinc-300">{p.author ?? 'Alguien'}</b> · {formatDate(p.date)}</div>
              <p className="mt-0.5 break-words whitespace-pre-wrap">{p.text}</p>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void publish(); } }}
        placeholder="Escribe un comentario para Rally…"
        rows={3}
        disabled={sending}
        className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-400 disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900"
      />
      {error && <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="text-xs text-zinc-400">Se publica en Rally con tu nombre · ⌘↵</span>
        <button
          type="button"
          onClick={() => void publish()}
          disabled={!text.trim() || sending}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          <Send className="size-3" />{sending ? 'Publicando…' : 'Publicar en Rally'}
        </button>
      </div>
    </Block>
  );
}

/** Adjuntos de Rally: se abren en Rally y se pueden subir más (botón o soltando archivos encima), de uno en uno. */
function Attachments({ item, files }: { item: RallyItem; files: RallyDetail['attachments'] }) {
  const [added, setAdded] = useState<RallyDetail['attachments']>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const all = [...files, ...added].filter((f) => !f.objectId || !removed.includes(f.objectId));

  const remove = async (f: RallyDetail['attachments'][number]) => {
    if (!f.objectId || !window.confirm(`¿Eliminar «${f.name}» de Rally? No se puede deshacer.`)) return;
    setError(null);
    setDeleting(f.objectId);
    try {
      await rallyApi.deleteAttachment(f.objectId);
      setRemoved((l) => [...l, f.objectId!]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  const upload = async (list: File[]) => {
    setError(null);
    for (const file of list) {
      if (file.size > MAX_UPLOAD) { setError(tooBigMessage(file)); continue; }
      setUploading(file.name);
      try {
        const done = await rallyApi.attach(item, { name: file.name, contentType: file.type, content: await toBase64(file) });
        setAdded((l) => [...l, done]);
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }
    setUploading(null);
  };

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        if (!uploading) void upload([...e.dataTransfer.files]);
      }}
      className={over ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}
    >
      <Block title={`Adjuntos · ${all.length}`}>
        {all.length > 0 && (
          <ul className="mb-2 space-y-1 text-sm">
            {all.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <Paperclip className="size-3.5 shrink-0 text-zinc-400" />
                <a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline" title="Se abre en Rally">{f.name}</a>
                <span className="shrink-0 text-xs text-zinc-400">{formatSize(f.size)}</span>
                {f.objectId && (
                  <button type="button" onClick={() => void remove(f)} disabled={!!deleting} title={`Eliminar ${f.name} de Rally`} aria-label={`Eliminar ${f.name} de Rally`}
                    className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950">
                    {deleting === f.objectId ? <span className="px-0.5 text-[11px]">…</span> : <Trash2 className="size-3.5" />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; if (list.length) void upload(list); }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={!!uploading}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-300 px-2 py-2 text-xs text-zinc-500 hover:border-indigo-400 hover:text-indigo-600 disabled:opacity-60 dark:border-zinc-600"
        >
          <Upload className="size-3.5" />
          {uploading ? `Subiendo ${uploading}…` : 'Adjuntar archivos a Rally (o suéltalos aquí) · máx. 25 MB'}
        </button>
        {error && <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      </Block>
    </div>
  );
}
