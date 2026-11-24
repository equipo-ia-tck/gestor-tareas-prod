import type { Chunk } from './knowledge';

/**
 * Respuestas con IA del Asistente (RAG), la parte pura: juntar la búsqueda por palabras (BM25) con la búsqueda por
 * significado (embeddings), elegir los trozos que caben en el contexto del modelo, montar el prompt y leer las citas [n]
 * de la respuesta. El modelo y los embeddings corren en el navegador (features/assistant/ai): nada sale del ordenador.
 */

/** Huella corta de un texto (FNV-1a), para no volver a calcular el embedding de un trozo que no ha cambiado. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Texto de un trozo tal como lo lee el modelo: título, apartado y contenido. */
export function chunkText(c: Chunk): string {
  const head = c.section ? `${c.title} › ${c.section}` : c.title;
  return c.text ? `${head}\n${c.text}` : head;
}

/** Clave de caché del embedding de un trozo (cambia si cambia el texto). */
export const chunkKey = (c: Chunk) => `${c.id}#${hashText(chunkText(c))}`;

/** Producto escalar (los vectores ya vienen normalizados: es el coseno). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Fusión por posición (Reciprocal Rank Fusion): cada lista aporta 1 / (k + puesto). Así se juntan la búsqueda por
 * palabras y la de significado sin tener que comparar sus puntuaciones, que no tienen la misma escala.
 */
export function fuseRanks(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export interface RagSource { n: number; chunk: Chunk; text: string }

/** Lo que cabe del contexto: unos 6.500 caracteres (~2.000 tokens) en un modelo con ventana de 4.096. */
export const CONTEXT_CHARS = 6500;
const MAX_SOURCES = 8;
const MAX_PER_SOURCE = 1600;

/**
 * Los trozos que se le dan al modelo, numerados para citarlos: en el orden de la búsqueda, sin repetir, recortados y
 * hasta llenar el presupuesto. Los trozos vacíos (un proyecto sin más) no aportan.
 */
export function pickContext(ranked: Chunk[], maxChars = CONTEXT_CHARS): RagSource[] {
  const out: RagSource[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const chunk of ranked) {
    if (out.length >= MAX_SOURCES) break;
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    let text = chunkText(chunk).trim();
    if (text.length < 15) continue;
    if (text.length > MAX_PER_SOURCE) text = `${text.slice(0, MAX_PER_SOURCE).trimEnd()}…`;
    if (used + text.length > maxChars) {
      const room = maxChars - used;
      if (room < 300) break;
      text = `${text.slice(0, room).trimEnd()}…`;
    }
    used += text.length;
    out.push({ n: out.length + 1, chunk, text });
  }
  return out;
}

const KIND: Record<Chunk['source'], string> = { doc: 'Documento', note: 'Nota', list: 'Lista', person: 'Persona', project: 'Proyecto', task: 'Tarea' };

export const NOT_FOUND = 'No lo encuentro en la documentación ni en Marea.';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** Ejemplo de pregunta y respuesta: a un modelo pequeño le enseña el formato mejor que cualquier regla. */
const EXAMPLE_USER = `FUENTES:
[1] (Documento) Medición web › Eventos
event12 | Compra | Se lanza al confirmar el pago
event13 | Carrito | Se lanza al añadir un producto
[2] (Nota) Reunión con Ana
Ana pide revisar el event13 antes del viernes.

PREGUNTA: ¿Qué evento se usa para la compra?`;
const EXAMPLE_ANSWER = 'Para la compra se usa el **event12**, que se lanza al confirmar el pago [1].';

/** El prompt: reglas cortas y claras (es un modelo pequeño), un ejemplo, las fuentes numeradas y la pregunta. */
export function buildMessages(question: string, sources: RagSource[], today: string): ChatMessage[] {
  const system = [
    'Eres el asistente de Marea, la herramienta de un equipo de analítica digital. Respondes en español, con frases completas.',
    `Hoy es ${today}.`,
    'Responde usando solo la información de las FUENTES; no añadas nada que no esté en ellas.',
    'Empieza por la respuesta directa en una frase completa y, si ayuda, añade una lista corta con los pasos o detalles.',
    'Al final de cada frase, pon entre corchetes el número de la fuente de donde sale, por ejemplo [1] o [2][3].',
    'Las fuentes pueden ser tablas con columnas separadas por «|»: cada línea es una fila.',
    'Las fuentes pueden decirlo con otras palabras (alta = registro, entrar = login…): si alguna responde, úsala.',
    `Solo si ninguna fuente tiene nada que ver con la pregunta, responde: ${NOT_FOUND}`,
  ].join('\n');
  const context = sources.map((s) => `[${s.n}] (${KIND[s.chunk.source]}) ${s.text}`).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: EXAMPLE_USER },
    { role: 'assistant', content: EXAMPLE_ANSWER },
    { role: 'user', content: `FUENTES:\n${context || '(ninguna)'}\n\nPREGUNTA: ${question}` },
  ];
}

/** La respuesta en trozos de texto y números de cita ([1], [2, 3] o [1][2]), solo los que existen. */
export function splitCitations(answer: string, max: number): (string | number)[] {
  const out: (string | number)[] = [];
  let at = 0;
  for (const m of answer.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) {
    const nums = m[1].split(/[,;]/).map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= max);
    if (!nums.length) continue;
    if (m.index! > at) out.push(answer.slice(at, m.index));
    out.push(...nums);
    at = m.index! + m[0].length;
  }
  if (at < answer.length) out.push(answer.slice(at));
  return out;
}

/** Las fuentes citadas, en el orden en que aparecen por primera vez. */
export function citedSources(answer: string, max: number): number[] {
  return [...new Set(splitCitations(answer, max).filter((x): x is number => typeof x === 'number'))];
}

/** ¿El modelo ha dicho que no lo sabe? */
export const isNotFound = (answer: string) => answer.replace(/[«»"]/g, '').trim().startsWith(NOT_FOUND.replace(/\.$/, ''));
