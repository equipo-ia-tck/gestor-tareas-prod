import { fold } from './text.ts';

/**
 * Buscador del Asistente, sin IA: trocea tareas, notas, personas, proyectos y documentos en fragmentos, los puntúa con
 * BM25 (lo que usan los buscadores clásicos: palabras raras pesan más, fragmentos cortos que las repiten ganan) y devuelve
 * el trozo de texto que mejor responde, con las palabras encontradas marcadas.
 */

/** Documento de la documentación del equipo (migración 013). */
export interface KnowledgeDoc {
  id: string;
  title: string;
  kind: 'text' | 'markdown' | 'pdf' | 'word' | 'other';
  fileName: string;
  visibility: 'team' | 'private';
  ownerName: string;
  mine: boolean;
  size: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type ChunkSource = 'task' | 'note' | 'doc' | 'person' | 'project' | 'list';

/** Un trozo buscable: de dónde sale, a qué apunta y su texto. */
export interface Chunk {
  id: string;
  source: ChunkSource;
  /** Id de la tarea, nota, documento, persona (su nombre), proyecto o elemento de la Lista. */
  ref: string;
  title: string;
  /** Apartado dentro del documento o la nota («Pasos > Validación»). */
  section?: string;
  text: string;
}

export interface Hit {
  chunk: Chunk;
  score: number;
  /** Trozo del texto alrededor de lo encontrado. */
  snippet: string;
  /** Rangos [inicio, fin) de `snippet` que coinciden con la búsqueda. */
  marks: [number, number][];
}

// Palabras que no ayudan a buscar (en español, plegadas).
const STOP = new Set(`a al algo algun alguna algunas alguno algunos ante antes aqui asi aun cada como con contra cual cuales cuando de
del desde donde dos e el ella ellas ellos en entre era es esa esas ese eso esos esta estan estas este esto estos fue ha hay
la las le les lo los mas me mi mis muy nada ni no nos o os otra otro para pero poco por porque que quien se sea segun ser si
sin sobre solo son su sus tambien te tiene tienen todo todos tu tus un una unas uno unos y ya yo hacer hace como cual
dime decir dice puedo puede quiero saber sabes busca buscar encuentra informacion info sobre explica explicame
usa usan usar uso utiliza utilizan utilizar sirve sirven sirva necesito necesita tengo tenemos quieres puedes podria podrias
favor gracias hola oye vale`.split(/\s+/));

/** Raíz sencilla: sin tildes, sin plural y sin las terminaciones más comunes (validaciones → validacion). */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('es') && /[^aeiou]es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}

/** Palabras buscables de un texto (plegadas, sin vacías, con su raíz). */
export function terms(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

const CHUNK_SIZE = 700;

/**
 * Trocea un texto largo por apartados (títulos en Markdown, líneas cortas en mayúsculas o terminadas en «:») y párrafos,
 * en trozos de unos 700 caracteres que guardan su apartado.
 */
export function splitSections(body: string): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  let section = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ section, text });
    buf = [];
  };
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1]
      ?? (line.length > 2 && line.length < 80 && (/^[^a-zà-ú]*[A-ZÁÉÍÓÚÑ][^a-zà-ú]*$/.test(line) || /^[^.]{3,70}:$/.test(line)) ? line.replace(/:$/, '') : null);
    if (heading) { flush(); section = heading.trim(); continue; }
    if (!line.trim()) {
      if (buf.join('\n').length >= CHUNK_SIZE) flush();
      else if (buf.length) buf.push('');
      continue;
    }
    buf.push(line);
    if (buf.join('\n').length >= CHUNK_SIZE * 1.6) flush();
  }
  flush();
  return out;
}

export function docChunks(doc: Pick<KnowledgeDoc, 'id' | 'title' | 'body'>): Chunk[] {
  return splitSections(doc.body).map((s, i) => ({ id: `doc:${doc.id}:${i}`, source: 'doc', ref: doc.id, title: doc.title, section: s.section || undefined, text: s.text }));
}

interface Indexed { chunk: Chunk; tf: Map<string, number>; len: number }

/** Índice BM25 sobre los trozos. Se crea una vez y se consulta muchas. */
export class SearchIndex {
  private docs: Indexed[] = [];
  private df = new Map<string, number>();
  private avg = 1;

  constructor(chunks: Chunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const tf = new Map<string, number>();
      // El título cuenta doble.
      const words = [...terms(chunk.title), ...terms(chunk.title), ...terms(chunk.section ?? ''), ...terms(chunk.text)];
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.docs.push({ chunk, tf, len: words.length });
      total += words.length;
    }
    this.avg = Math.max(1, total / Math.max(1, this.docs.length));
  }

  get size() { return this.docs.length; }

  search(query: string, opts: { limit?: number; sources?: ChunkSource[] } = {}): Hit[] {
    const q = [...new Set(terms(query))];
    if (!q.length) return [];
    const n = this.docs.length;
    const phrase = fold(query).replace(/\s+/g, ' ').trim();
    const scored: { d: Indexed; score: number }[] = [];
    for (const d of this.docs) {
      if (opts.sources && !opts.sources.includes(d.chunk.source)) continue;
      let score = 0;
      let matched = 0;
      for (const w of q) {
        const f = d.tf.get(w) ?? prefixCount(d.tf, w);
        if (!f) continue;
        matched++;
        const df = this.df.get(w) ?? 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / this.avg))));
      }
      if (!matched) continue;
      // Que estén todas las palabras pesa mucho; la frase exacta, más.
      score *= 0.5 + matched / q.length;
      if (phrase.length > 3 && fold(`${d.chunk.title} ${d.chunk.text}`).includes(phrase)) score *= 1.6;
      scored.push({ d, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8)
      .map(({ d, score }) => ({ chunk: d.chunk, score, ...snippet(d.chunk.text, q) }));
  }
}

/** Palabras que empiezan por la buscada (con 4 letras o más): «valid» encuentra «validacion». */
function prefixCount(tf: Map<string, number>, w: string): number {
  if (w.length < 4) return 0;
  let n = 0;
  for (const [k, f] of tf) if (k.length > w.length && k.startsWith(w)) n += f;
  return n * 0.7;
}

/** El trozo de ~260 caracteres con más palabras buscadas, con sus rangos marcados. */
export function snippet(text: string, q: string[], size = 260): { snippet: string; marks: [number, number][] } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = [...clean.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, t: stem(fold(m[0])) }));
  const hit = (t: string) => q.some((w) => t === w || (w.length >= 4 && t.startsWith(w)));
  const hits = words.filter((w) => hit(w.t));
  let start = 0;
  if (clean.length > size && hits.length) {
    let best = 0;
    for (const h of hits) {
      const s = Math.max(0, h.start - 60);
      const count = hits.filter((x) => x.start >= s && x.end <= s + size).length;
      if (count > best) { best = count; start = s; }
    }
    // Empezar en un principio de palabra.
    const space = clean.lastIndexOf(' ', start);
    start = start > 0 && space >= 0 && start - space < 20 ? space + 1 : start;
  }
  const end = Math.min(clean.length, start + size);
  const prefix = start > 0 ? '…' : '';
  const out = prefix + clean.slice(start, end) + (end < clean.length ? '…' : '');
  const marks = hits.filter((h) => h.start >= start && h.end <= end).map((h) => [h.start - start + prefix.length, h.end - start + prefix.length] as [number, number]);
  return { snippet: out, marks };
}
