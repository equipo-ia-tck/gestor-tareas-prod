/**
 * Worker de embeddings del Asistente (búsqueda por significado): multilingual-e5-small cuantizado (~120 MB, se descarga
 * una vez y queda en la caché del navegador) con transformers.js en WebAssembly. Recibe textos y devuelve vectores de 384
 * dimensiones normalizados. Corre aparte para no congelar la pantalla mientras indexa.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
const MODEL = 'Xenova/multilingual-e5-small';
let extractor: Promise<FeatureExtractionPipeline> | null = null;

type Request = { id: number; texts: string[] };

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, texts } = e.data;
  try {
    extractor ??= pipeline('feature-extraction', MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === 'progress' && typeof p.progress === 'number') self.postMessage({ id: -1, progress: p.progress });
      },
    }) as Promise<FeatureExtractionPipeline>;
    const run = await extractor;
    const out = await run(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const data = out.data as Float32Array;
    const vectors = texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
    self.postMessage({ id, vectors }, { transfer: vectors.map((v) => v.buffer) });
  } catch (err) {
    extractor = null;
    self.postMessage({ id, error: (err as Error).message || String(err) });
  }
};
