import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Cpu, Download, ExternalLink, Loader2, Sparkles, Square, Trash2 } from 'lucide-react';
import { routeHref } from '../../../app/router';
import type { Chunk } from '../../../domain/knowledge';
import { buildMessages, citedSources, fuseRanks, isNotFound, NOT_FOUND, pickContext, splitCitations, type RagSource } from '../../../domain/rag';
import { usePersistentState } from '../../../hooks/usePersistentState';
import { track } from '../../usage/track';
import { generate, MODELS, modelCached, modelLabel, removeModel, semanticSearch, startLlm, useAi, type ModelSize } from './engine';

/** ¿Respuestas con IA activadas en este navegador? (Es decisión de cada persona: descarga ~2 GB.) */
export const useAiEnabled = () => usePersistentState<boolean>('asistente-ia', false);
/** Qué modelo usa esta persona en este navegador: el normal o el grande. */
export const useAiModel = () => usePersistentState<ModelSize>('asistente-ia-modelo', 'normal');

interface Result { status: 'searching' | 'writing' | 'done' | 'error' | 'stopped'; text: string; sources: RagSource[]; error?: string; abort?: AbortController }

// Las respuestas se quedan mientras dure la sesión, como la conversación: no se vuelven a generar al cambiar de pantalla.
const results = new Map<string, Result>();
const listeners = new Set<() => void>();
let version = 0;
const setResult = (id: string, r: Result) => {
  results.set(id, r);
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const useResults = () => useSyncExternalStore(subscribe, () => version);

async function answer(id: string, query: string, keywordHits: Chunk[], all: Chunk[], today: string) {
  const abort = new AbortController();
  setResult(id, { status: 'searching', text: '', sources: [], abort });
  try {
    const semantic = await semanticSearch(query, all, 20).catch(() => [] as Chunk[]);
    const byId = new Map([...keywordHits, ...semantic].map((c) => [c.id, c]));
    const ranked = fuseRanks([keywordHits.map((c) => c.id), semantic.map((c) => c.id)]).map((x) => byId.get(x)!).filter(Boolean);
    const sources = pickContext(ranked);
    if (!sources.length) {
      setResult(id, { status: 'done', text: NOT_FOUND, sources: [] });
      return;
    }
    setResult(id, { status: 'writing', text: '', sources, abort });
    const started = performance.now();
    const text = await generate(buildMessages(query, sources, today), (t) => setResult(id, { status: 'writing', text: t, sources, abort }), abort.signal);
    setResult(id, { status: abort.signal.aborted ? 'stopped' : 'done', text, sources });
    track('assistant-ai', `answer:${Math.round((performance.now() - started) / 1000)}s`);
  } catch (e) {
    setResult(id, { status: 'error', text: '', sources: [], error: (e as Error).message });
  }
}

/**
 * Respuesta redactada por la IA local a partir de lo que encuentra la búsqueda (documentos, notas, Lista, fichas,
 * tareas), con las fuentes numeradas y enlazadas. Si el modelo aún se está cargando, espera y responde después.
 */
export function AiAnswer({ entryId, query, keywordHits, chunks, today, onTask, fallback }: {
  entryId: string; query: string; keywordHits: Chunk[]; chunks: Chunk[]; today: string; onTask: (id: string) => void;
  /** Lo que se enseña si la IA no lo encuentra o falla (la frase que mejor responde, sin IA): así nunca queda en blanco. */
  fallback?: ReactNode;
}) {
  useResults();
  const ai = useAi();
  const r = results.get(entryId);
  useEffect(() => {
    if (ai.llm === 'ready' && !results.has(entryId)) void answer(entryId, query, keywordHits, chunks, today);
  }, [ai.llm, entryId]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = (children: ReactNode) => (
    <div className="mb-3 rounded-md border-l-4 border-violet-500 bg-violet-50/60 px-3 py-2 text-sm dark:bg-violet-950/40">{children}</div>
  );
  const head = (extra?: ReactNode) => (
    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-300"><Sparkles className="size-3.5" />Respuesta con IA{extra}</p>
  );

  if (!r) {
    if (ai.llm === 'unsupported' || ai.llm === 'error' || ai.llm === 'off') return null;
    return box(<>{head()}<p className="flex items-center gap-1.5 text-zinc-500"><Loader2 className="size-3.5 animate-spin" />Cargando el modelo{ai.progress ? ` (${Math.round(ai.progress * 100)} %)` : ''}… Responderé en cuanto esté.</p></>);
  }
  if (r.status === 'error') return <>{box(<>{head()}<p className="text-amber-700 dark:text-amber-300">No he podido responder: {r.error}</p></>)}{fallback}</>;
  if (r.status === 'searching') return box(<>{head()}<p className="flex items-center gap-1.5 text-zinc-500"><Loader2 className="size-3.5 animate-spin" />Buscando en la documentación…</p></>);

  const cited = citedSources(r.text, r.sources.length);
  const notFound = r.status !== 'writing' && isNotFound(r.text);
  if (notFound) {
    return (
      <>
        {box(<>{head()}<p className="text-zinc-600 dark:text-zinc-300">La IA no lo ha encontrado con seguridad.{fallback ? ' Esto es lo más parecido que hay en la documentación:' : ' Mira abajo lo que ha salido en la búsqueda o pregunta a Claude.'}</p></>)}
        {fallback}
      </>
    );
  }
  return box(
    <>
      {head(r.status === 'writing' && (
        <button type="button" onClick={() => r.abort?.abort()} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-violet-100 dark:hover:bg-violet-900">
          <Square className="size-3" />Parar
        </button>
      ))}
      <AnswerText text={r.text || '…'} sources={r.sources} onTask={onTask} />
      {r.status === 'stopped' && <p className="mt-1 text-xs text-zinc-400">(Parada)</p>}
      {!notFound && r.status !== 'writing' && (cited.length > 0 || r.sources.length > 0) && (
        <ol className="mt-2 space-y-0.5 border-t border-violet-200 pt-1.5 text-xs dark:border-violet-900">
          {(cited.length ? cited : r.sources.map((s) => s.n)).map((n) => {
            const s = r.sources[n - 1];
            return <li key={n} className="flex gap-1.5"><span className="text-zinc-400">[{n}]</span><SourceLink chunk={s.chunk} onTask={onTask} /></li>;
          })}
        </ol>
      )}
      {r.status !== 'writing' && <p className="mt-1.5 text-[11px] text-zinc-400">Redactada por {modelLabel(ai.model)} en tu ordenador con lo encontrado. Puede equivocarse: comprueba la fuente.</p>}
    </>,
  );
}

/** Texto de la respuesta: párrafos, listas, **negrita** y las citas [n] como enlaces a su fuente. */
function AnswerText({ text, sources, onTask }: { text: string; sources: RagSource[]; onTask: (id: string) => void }) {
  const inline = (line: string, key: string) => splitCitations(line, sources.length).map((part, i) => {
    if (typeof part === 'number') {
      return <SourceLink key={`${key}-${i}`} chunk={sources[part - 1].chunk} onTask={onTask} label={`[${part}]`} compact />;
    }
    return part.split(/(\*\*[^*]+\*\*)/g).map((s, j) => (s.startsWith('**') && s.endsWith('**') && s.length > 4
      ? <strong key={`${key}-${i}-${j}`}>{s.slice(2, -2)}</strong> : s));
  });
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={`ul-${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-5">{items}</ul>);
    items = [];
  };
  lines.forEach((line, i) => {
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { items.push(<li key={i}>{inline(li[1], `l${i}`)}</li>); return; }
    flush();
    if (line.trim()) blocks.push(<p key={i} className="text-zinc-800 dark:text-zinc-100">{inline(line.replace(/^#+\s*/, ''), `p${i}`)}</p>);
  });
  flush();
  return <div className="space-y-1">{blocks}</div>;
}

/** Enlace a la fuente de un trozo: documento de SharePoint, nota, ficha, Lista, proyecto o tarea. */
function SourceLink({ chunk: c, onTask, label, compact }: { chunk: Chunk; onTask: (id: string) => void; label?: string; compact?: boolean }) {
  const text = label ?? `${c.title}${c.section ? ` › ${c.section}` : ''}`;
  const cls = compact
    ? 'mx-0.5 align-super text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300'
    : 'inline-flex items-center gap-1 text-zinc-700 hover:underline dark:text-zinc-200';
  const title = `${c.title}${c.section ? ` › ${c.section}` : ''}`;
  switch (c.source) {
    case 'doc': return <a href={c.ref} target="_blank" rel="noreferrer" className={cls} title={title}>{text}{!compact && <ExternalLink className="size-3 text-zinc-400" />}</a>;
    case 'note': return <a href={routeHref({ view: 'notes', id: c.ref })} className={cls} title={title}>{text}</a>;
    case 'person': return <a href={routeHref({ view: 'person', name: c.ref })} className={cls} title={title}>{text}</a>;
    case 'project': return <a href={routeHref({ view: 'project', id: c.ref })} className={cls} title={title}>{text}</a>;
    case 'list': return <a href={routeHref({ view: 'lista' })} className={cls} title={title}>{text}</a>;
    case 'task': return <button type="button" onClick={() => onTask(c.ref)} className={cls} title={title}>{text}</button>;
  }
}

/** Panel lateral: activar la IA, estado de la descarga y del índice, y borrar el modelo. */
export function AiPanel() {
  const [enabled, setEnabled] = useAiEnabled();
  const [size, setSize] = useAiModel();
  const ai = useAi();
  const pct = (n: number) => `${Math.round(n * 100)} %`;
  const m = MODELS[size];

  const confirmDownload = async (s: ModelSize) => {
    const cached = await modelCached(s);
    if (!cached && !confirm(`Se descargará el modelo ${MODELS[s].label} (${MODELS[s].download}) en este navegador, una sola vez. Mejor con wifi y el ordenador enchufado. ¿Seguimos?`)) return null;
    return cached;
  };
  const enable = async () => {
    const cached = await confirmDownload(size);
    if (cached === null) return;
    setEnabled(true);
    track('assistant-ai', cached ? 'enable' : 'download');
    void startLlm(size);
  };
  const choose = async (s: ModelSize) => {
    if (s === size) return;
    if (enabled) {
      const cached = await confirmDownload(s);
      if (cached === null) return;
      track('assistant-ai', `model-${s}`);
      setSize(s);
      void startLlm(s);
    } else {
      setSize(s);
    }
  };
  const disable = async (remove: boolean) => {
    if (remove && !confirm('¿Borrar el modelo de este navegador? Para volver a usar la IA habrá que descargarlo otra vez.')) return;
    setEnabled(false);
    if (remove) await removeModel();
  };

  return (
    <section className="rounded-lg border border-violet-200 p-3 text-sm dark:border-violet-900">
      <h2 className="mb-1 flex items-center gap-1.5 font-semibold"><Sparkles className="size-4 text-violet-500" />Respuestas con IA</h2>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        Un modelo de IA ({m.label}) redacta la respuesta con lo que encuentra en la documentación, las notas, la Lista y tus tareas, y
        cita de dónde sale cada cosa. Funciona <strong>en tu ordenador</strong>: no se envía nada a ningún sitio y no cuesta nada.
      </p>
      <fieldset className="mb-2 space-y-1" disabled={ai.llm === 'loading' || ai.llm === 'checking'}>
        <legend className="mb-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">Modelo</legend>
        {(Object.keys(MODELS) as ModelSize[]).map((k) => (
          <label key={k} className="flex cursor-pointer items-start gap-1.5 text-xs">
            <input type="radio" name="ai-model" className="mt-0.5 accent-violet-600" checked={size === k} onChange={() => void choose(k)} />
            <span><strong>{k === 'normal' ? 'Normal' : 'Grande'}</strong> · {MODELS[k].label}, {MODELS[k].download} · <span className="text-zinc-500">{MODELS[k].hint}</span></span>
          </label>
        ))}
      </fieldset>
      {!enabled ? (
        <button type="button" onClick={() => void enable()} className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500">
          <Download className="size-3.5" />Activar (descarga {m.download} una vez)
        </button>
      ) : (
        <>
          {ai.llm === 'unsupported' && <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">Este ordenador no puede usar la IA: {ai.error} Seguirás teniendo las respuestas sin IA.</p>}
          {ai.llm === 'error' && (
            <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
              No se ha podido cargar el modelo: {ai.error} <button type="button" onClick={() => void startLlm(size)} className="font-medium underline">Reintentar</button>
            </p>
          )}
          {(ai.llm === 'loading' || ai.llm === 'checking') && (
            <div className="mb-2">
              <p className="mb-1 flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"><Loader2 className="size-3.5 animate-spin" />Cargando el modelo · {pct(ai.progress)}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"><div className="h-full bg-violet-500 transition-all" style={{ width: pct(ai.progress) }} /></div>
              {ai.progressText && <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{ai.progressText}</p>}
            </div>
          )}
          {ai.llm === 'ready' && <p className="mb-1 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300"><Cpu className="size-3.5" />{modelLabel(ai.model)} listo · {ai.model.includes('f16') ? 'gráfica con f16' : 'gráfica sin f16 (algo más lento)'}</p>}
          <p className="mb-2 text-xs text-zinc-500">
            Búsqueda por significado: {ai.embed === 'error' ? <span className="text-amber-700 dark:text-amber-300">falla ({ai.embedError}); se busca solo por palabras</span>
              : ai.embed === 'ready' ? `${ai.total} trozos indexados`
                : ai.embed === 'off' ? 'esperando'
                  : ai.embed === 'loading' && !ai.indexed ? `descargando el modelo (~120 MB)${ai.embedProgress ? ` · ${pct(ai.embedProgress)}` : ''}`
                    : `indexando ${ai.indexed} de ${ai.total}`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => void disable(false)} className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">Desactivar</button>
            <button type="button" onClick={() => void disable(true)} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"><Trash2 className="size-3" />Borrar el modelo</button>
          </div>
        </>
      )}
    </section>
  );
}
