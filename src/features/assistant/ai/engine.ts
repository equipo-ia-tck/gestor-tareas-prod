import { useSyncExternalStore } from 'react';
import type { WebWorkerMLCEngine } from '@mlc-ai/web-llm';
import type { Chunk } from '../../../domain/knowledge';
import { chunkKey, chunkText, cosine, type ChatMessage } from '../../../domain/rag';

/**
 * Motor de IA del Asistente, todo en el navegador (sin servidor, sin APIs, sin tokens; nada sale del ordenador):
 *  · Modelo de lenguaje: Qwen2.5-3B-Instruct (o, si se elige, el grande: Qwen3.5-9B, con ventana de 16k y unas 20 partes de documentación) con WebLLM en la gráfica
 *    (WebGPU). ~2 GB (~6,5 GB el grande) que se descargan una vez y quedan en la caché del navegador.
 *  · Búsqueda por significado: embeddings multilingual-e5-small con transformers.js. Los vectores se guardan solo en
 *    memoria de la pestaña (los documentos de CaixaBank no se guardan en ningún sitio).
 */

export type LlmStatus = 'off' | 'checking' | 'unsupported' | 'loading' | 'ready' | 'error';
export type EmbedStatus = 'off' | 'loading' | 'indexing' | 'ready' | 'error';

export interface AiState {
  llm: LlmStatus;
  /** 0-1 mientras se descarga o se carga el modelo. */
  progress: number;
  progressText: string;
  error: string | null;
  model: string;
  embed: EmbedStatus;
  embedProgress: number;
  indexed: number;
  total: number;
  embedError: string | null;
}

/**
 * Modelos que se pueden elegir (cada persona, en el panel): el normal, ligero y rápido, y el grande, que razona y redacta
 * bastante mejor pero pesa más del doble y necesita una gráfica con memoria (un Mac con chip M va bien). De cada uno, con
 * números de 16 bits si la gráfica los admite (más rápido y ligero); si no, el de 32.
 */
export type ModelSize = 'normal' | 'grande';
export interface ModelInfo {
  f16: string; f32: string; label: string; download: string; hint: string;
  /** Ventana del modelo (tokens): pregunta + documentación + respuesta. */
  context: number;
  /** Cuánta documentación se le da (caracteres y trozos), cuántos trozos trae la búsqueda por significado y cuánto puede escribir. */
  budget: { chars: number; sources: number; semantic: number; maxTokens: number };
  /** Modelos que «piensan en voz alta» (Qwen3): se les pide que no lo hagan. */
  thinking?: boolean;
}
export const MODELS: Record<ModelSize, ModelInfo> = {
  normal: {
    f16: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC', label: 'Qwen2.5 3B', download: '~2 GB',
    hint: 'rápido, va en casi cualquier ordenador; lee unas 8 partes de la documentación',
    context: 4096, budget: { chars: 6500, sources: 8, semantic: 20, maxTokens: 450 },
  },
  grande: {
    f16: 'Qwen3.5-9B-q4f16_1-MLC', f32: 'Qwen3.5-9B-q4f32_1-MLC', label: 'Qwen3.5 9B', download: '~6,5 GB',
    hint: 'responde mucho mejor y lee unas 20 partes de la documentación; para un Mac con chip M y 16 GB o más',
    context: 16384, budget: { chars: 26000, sources: 20, semantic: 40, maxTokens: 800 }, thinking: true,
  },
};
export const MODEL_F16 = MODELS.normal.f16;
export const MODEL_F32 = MODELS.normal.f32;
const infoOf = (id: string) => Object.values(MODELS).find((m) => m.f16 === id || m.f32 === id) ?? MODELS.normal;
/** Nombre del modelo cargado (para «Redactada por…»). */
export const modelLabel = (id: string) => infoOf(id).label;
/** Cuánta documentación se le da al modelo cargado. */
export const aiBudget = () => infoOf(state.model).budget;
/** El grande de antes (Qwen2.5 7B): ya no se ofrece, pero «Borrar el modelo» también lo quita. */
const OLD_MODELS = ['Qwen2.5-7B-Instruct-q4f16_1-MLC', 'Qwen2.5-7B-Instruct-q4f32_1-MLC'];
const ALL_MODELS = [...Object.values(MODELS).flatMap((m) => [m.f16, m.f32]), ...OLD_MODELS];

let state: AiState = { llm: 'off', progress: 0, progressText: '', error: null, model: MODEL_F16, embed: 'off', embedProgress: 0, indexed: 0, total: 0, embedError: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<AiState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useAi = () => useSyncExternalStore(subscribe, () => state);
export const aiState = () => state;

interface GpuAdapter { features: Set<string> }
interface GpuNavigator { gpu?: { requestAdapter: (o?: { powerPreference?: string }) => Promise<GpuAdapter | null> } }

/** ¿Hay WebGPU? Y, si lo hay, ¿admite f16? */
export async function webgpuSupport(): Promise<{ ok: boolean; f16: boolean; reason?: string }> {
  const gpu = (navigator as unknown as GpuNavigator).gpu;
  if (!gpu) return { ok: false, f16: false, reason: 'Este navegador no tiene WebGPU. Usa Chrome o Edge actualizados.' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, f16: false, reason: 'La gráfica de este ordenador no está disponible para WebGPU.' };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, f16: false, reason: (e as Error).message };
  }
}

/** ¿Ese modelo ya está descargado en este navegador? */
export async function modelCached(size: ModelSize = 'normal'): Promise<boolean> {
  try {
    const { hasModelInCache } = await import('./webllm');
    return (await hasModelInCache(MODELS[size].f16)) || (await hasModelInCache(MODELS[size].f32));
  } catch {
    return false;
  }
}

let engine: WebWorkerMLCEngine | null = null;
let llmWorker: Worker | null = null;
let loadedSize: ModelSize | null = null;
let loading: Promise<void> | null = null;

/**
 * Descarga (la primera vez) y carga el modelo elegido. Se puede llamar varias veces: solo carga uno; si ya hay otro
 * cargado, lo suelta y carga el nuevo.
 */
export function startLlm(size: ModelSize = 'normal'): Promise<void> {
  if (engine && loadedSize === size) return Promise.resolve();
  if (loading) return loading.then(() => startLlm(size));
  loading = (async () => {
    if (engine) {
      try { await engine.unload(); } catch { /* ya estaba suelto */ }
      llmWorker?.terminate();
      engine = null;
      llmWorker = null;
      loadedSize = null;
    }
    set({ llm: 'checking', error: null });
    const gpu = await webgpuSupport();
    if (!gpu.ok) {
      set({ llm: 'unsupported', error: gpu.reason ?? 'Sin WebGPU.' });
      return;
    }
    const model = gpu.f16 ? MODELS[size].f16 : MODELS[size].f32;
    set({ llm: 'loading', model, progress: 0, progressText: 'Preparando…' });
    try {
      const { CreateWebWorkerMLCEngine } = await import('./webllm');
      llmWorker = new Worker(new URL('./llmWorker.ts', import.meta.url), { type: 'module' });
      engine = await CreateWebWorkerMLCEngine(llmWorker, model, {
        initProgressCallback: (r) => set({ progress: r.progress, progressText: r.text }),
      }, { context_window_size: MODELS[size].context });
      loadedSize = size;
      set({ llm: 'ready', progress: 1, progressText: '' });
    } catch (e) {
      engine = null;
      llmWorker?.terminate();
      llmWorker = null;
      const message = (e as Error).message || String(e);
      set({ llm: 'error', error: size === 'grande' && /memory|buffer|limit|device/i.test(message)
        ? `la gráfica no tiene memoria para el modelo grande (${message}). Vuelve al normal.` : message });
    }
  })().finally(() => { loading = null; });
  return loading;
}

/** Libera la gráfica y borra los modelos descargados de este navegador. */
export async function removeModel(): Promise<void> {
  try { await engine?.unload(); } catch { /* ya estaba descargado */ }
  llmWorker?.terminate();
  engine = null;
  llmWorker = null;
  loadedSize = null;
  const { deleteModelAllInfoInCache } = await import('./webllm');
  for (const m of ALL_MODELS) await deleteModelAllInfoInCache(m).catch(() => undefined);
  set({ llm: 'off', progress: 0, progressText: '', error: null });
}

let busy: Promise<unknown> = Promise.resolve();

/** Quita lo que un modelo «pensante» escriba entre <think> y </think> (también si aún no lo ha cerrado). */
export function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, '').replace(/^\s+/, '');
}

/**
 * Genera la respuesta en streaming. `onText` recibe el texto acumulado. Las peticiones van en cola (el modelo responde
 * de una en una). `signal` la para.
 */
export function generate(messages: ChatMessage[], onText: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const run = async () => {
    if (!engine) throw new Error('El modelo no está cargado.');
    if (signal?.aborted) return '';
    const stop = () => engine?.interruptGenerate();
    signal?.addEventListener('abort', stop);
    try {
      const info = infoOf(state.model);
      const stream = await engine.chat.completions.create({
        messages, stream: true, temperature: 0.1, top_p: 0.9, max_tokens: info.budget.maxTokens,
        ...(info.thinking ? { extra_body: { enable_thinking: false } } : {}),
      });
      let raw = '';
      for await (const part of stream) {
        raw += part.choices[0]?.delta?.content ?? '';
        onText(withoutThinking(raw));
      }
      await engine.resetChat();
      return withoutThinking(raw);
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  };
  const next = busy.then(run, run);
  busy = next.catch(() => undefined);
  return next;
}

// --- Búsqueda por significado ---

let embedWorker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

function worker(): Worker {
  if (embedWorker) return embedWorker;
  embedWorker = new Worker(new URL('./embedWorker.ts', import.meta.url), { type: 'module' });
  embedWorker.onmessage = (e: MessageEvent<{ id: number; vectors?: Float32Array[]; error?: string; progress?: number }>) => {
    const { id, vectors, error, progress } = e.data;
    if (id === -1) { if (state.embed === 'loading') set({ embedProgress: (progress ?? 0) / 100 }); return; }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(vectors ?? []);
  };
  return embedWorker;
}

function embed(texts: string[]): Promise<Float32Array[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker().postMessage({ id, texts });
  });
}

/** Vectores de los trozos ya calculados (por `chunkKey`), en memoria. */
const vectors = new Map<string, Float32Array>();
let indexRun = 0;

/**
 * Los vectores de la documentación de Confluence (trozos `cf:`) también se guardan en IndexedDB, para no recalcular cientos
 * de páginas en cada sesión: ese export está aprobado para salir de CaixaBank. Los de las carpetas de SharePoint, notas,
 * Lista y fichas se quedan solo en memoria, como siempre.
 */
const persistable = (c: Chunk) => c.id.startsWith('cf:');
const DB_NAME = 'marea-ia';
const STORE = 'vectors';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Carga de IndexedDB los vectores que faltan en memoria (los de los trozos que se van a indexar). */
async function restoreVectors(keys: string[]): Promise<void> {
  const db = await openDb();
  if (!db || !keys.length) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    for (const k of keys) {
      const r = store.get(k);
      r.onsuccess = () => { if (r.result instanceof Float32Array) vectors.set(k, r.result); };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Guarda vectores y quita los que ya no corresponden a ningún trozo (páginas cambiadas o borradas). */
async function storeVectors(entries: [string, Float32Array][], keep?: Set<string>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [k, v] of entries) store.put(v, k);
    if (keep) {
      const r = store.getAllKeys();
      r.onsuccess = () => { for (const k of r.result) if (!keep.has(String(k))) store.delete(k); };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Los trozos que vale la pena indexar por significado (las tareas son títulos cortos: con las palabras basta). */
const semanticWorthy = (c: Chunk) => c.source !== 'task' && c.source !== 'project' && chunkText(c).length >= 25;

/**
 * Calcula, en segundo plano y por lotes, los embeddings de los trozos que aún no los tienen. Si llega otro índice
 * (cambian las notas o los documentos), el anterior se deja a medias y sigue el nuevo con lo ya calculado.
 */
export async function indexChunks(chunks: Chunk[]): Promise<void> {
  const run = ++indexRun;
  const todo = chunks.filter(semanticWorthy);
  const saved = todo.filter(persistable).map(chunkKey);
  await restoreVectors(saved.filter((k) => !vectors.has(k)));
  if (run !== indexRun) return;
  // Solo se limpia cuando ya ha llegado la documentación (si aún no, `saved` está vacío y lo borraría todo).
  if (saved.length) void storeVectors([], new Set(saved));
  const missing = todo.filter((c) => !vectors.has(chunkKey(c)));
  set({ total: todo.length, indexed: todo.length - missing.length, embedError: null, embed: missing.length ? (vectors.size ? 'indexing' : 'loading') : 'ready' });
  const BATCH = 16;
  try {
    for (let i = 0; i < missing.length; i += BATCH) {
      if (run !== indexRun) return;
      const batch = missing.slice(i, i + BATCH);
      // e5 pide el prefijo «passage: » en los textos y «query: » en las preguntas.
      const out = await embed(batch.map((c) => `passage: ${chunkText(c).slice(0, 1500)}`));
      batch.forEach((c, j) => vectors.set(chunkKey(c), out[j]));
      const toSave = batch.flatMap((c, j): [string, Float32Array][] => (persistable(c) ? [[chunkKey(c), out[j]]] : []));
      if (toSave.length) void storeVectors(toSave);
      if (run === indexRun) set({ embed: 'indexing', indexed: state.indexed + batch.length });
    }
    if (run === indexRun) set({ embed: 'ready' });
  } catch (e) {
    if (run === indexRun) set({ embed: 'error', embedError: (e as Error).message });
  }
}

/** Los trozos más parecidos en significado a la pregunta (de los ya indexados). */
export async function semanticSearch(query: string, chunks: Chunk[], limit = 20): Promise<Chunk[]> {
  if (!vectors.size) return [];
  const [q] = await embed([`query: ${query}`]);
  return chunks
    .map((c) => ({ c, v: vectors.get(chunkKey(c)) }))
    .filter((x): x is { c: Chunk; v: Float32Array } => !!x.v)
    .map(({ c, v }) => ({ c, s: cosine(q, v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}
