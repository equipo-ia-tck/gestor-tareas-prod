import { fold } from './text';
import { terms, type Chunk } from './knowledge';

/**
 * «Dame las evar que hay», «¿qué props tenemos?», «lista de eventos»: una lista **exacta**, sin IA. Se recorre todo lo que
 * tiene el Asistente (documentación, notas, la Lista…) buscando identificadores con esa palabra y un número (`eVar69`,
 * `prop12`, `event5`) y, de cada uno, la línea donde mejor se explica y en qué página sale. Nada se inventa ni se resume:
 * cada fila es texto que está en la fuente.
 */

export interface InventorySource { title: string; section?: string; source: Chunk['source']; ref: string }
export interface InventoryItem {
  /** Como se escribe más a menudo («eVar69»). */
  id: string;
  num: number;
  /** La línea que mejor lo explica (una fila de tabla si la hay), recortada. */
  line: string;
  /** Dónde sale (hasta 3 sitios distintos) y cuántas veces en total. */
  sources: InventorySource[];
  count: number;
}
export interface Inventory {
  term: string;
  items: InventoryItem[];
  truncated: boolean;
  /** Palabras que acotan la lista («onboarding»): solo cuenta lo que sale donde se habla de ellas. */
  about: string[];
}

/** ¿Es una pregunta de «todas las X»? (o «qué X se usan…», en plural). */
const LIST_WORDS = /\b(dame|dime|lista|listado|listame|muestrame|ensename|cuales son|cuales hay|que .*\b(hay|existen|tenemos|tiene)|todas|todos|enumera|relacion de|inventario|que \w+ se (usan|utilizan))\b/;
/** «Qué evar se usa para el login», «cuál es la…»: una pregunta concreta (para la búsqueda), no una lista. */
const SPECIFIC = /\b(que \w+ se (usa|utiliza)|cual es)\b/;
/** Palabras de pedir la lista, que no acotan nada. */
const FILLER = new Set(terms('dame dime lista listado listame muestrame ensename enumera relacion inventario hay existen tenemos tiene '
  + 'todas todos puedes podrias dar usan usa usar utilizan sirven cosas cosa variables variable cuales que se'));

const MAX_ITEMS = 300;
const NUM = /^[\s_-]?(\d{1,4})(?![\p{L}\p{N}])/u;

/** Formas de una palabra para buscar identificadores: «evars» → evar; «eventos» → evento, event. */
function variants(word: string): string[] {
  const out = new Set([word]);
  if (word.endsWith('es')) out.add(word.slice(0, -2));
  if (word.endsWith('s')) out.add(word.slice(0, -1));
  if (word.endsWith('os')) out.add(word.slice(0, -2));
  if (word.endsWith('o')) out.add(word.slice(0, -1));
  return [...out].filter((w) => w.length >= 3);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Identificadores `<término><número>` de un texto (con la forma escrita y la línea). */
function scan(text: string, term: string, onHit: (raw: string, num: number, line: string) => void) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?=[\\s_-]?\\d)`, 'giu');
  for (const line of text.split('\n')) {
    if (!re.test(fold(line))) { re.lastIndex = 0; continue; }
    re.lastIndex = 0;
    const folded = fold(line);
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded))) {
      const n = NUM.exec(folded.slice(m.index + m[0].length));
      if (!n) continue;
      // La forma escrita, del texto original (fold no cambia la longitud de las letras sin tilde de estos identificadores).
      const raw = line.slice(m.index, m.index + m[0].length + n[0].length).replace(/[\s_-]/g, '');
      onHit(raw, Number(n[1]), line);
    }
  }
}

/** Cuánto vale una línea para explicar un identificador: las filas de tabla («Columna: valor | …») y con más texto, mejor. */
const lineScore = (line: string) => (line.includes('|') && line.includes(':') ? 2 : 0) + Math.min(line.trim().length, 220) / 220;

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 260 ? `${t.slice(0, 257)}…` : t;
};

export function inventory(chunks: Chunk[], question: string): Inventory | null {
  const f = fold(question);
  if (!LIST_WORDS.test(f) || SPECIFIC.test(f)) return null;
  const words = (f.match(/[\p{L}]+/gu) ?? []).filter((w) => w.length >= 3);
  let best: Inventory | null = null;
  const chunkTerms = new Map<string, Set<string>>();
  const termsOf = (c: Chunk) => {
    let t = chunkTerms.get(c.id);
    if (!t) { t = new Set(terms(`${c.title} ${c.section ?? ''} ${c.text}`)); chunkTerms.set(c.id, t); }
    return t;
  };
  for (const term of [...new Set(words.flatMap(variants))]) {
    // Lo que queda de la pregunta quitando la palabra buscada y las de pedir la lista: acota («de onboarding»).
    const own = new Set(terms(variants(term).concat(words.filter((w) => variants(w).includes(term))).join(' ')));
    const about = [...new Set(terms(question))].filter((t) => !FILLER.has(t) && !own.has(t) && !/^\d+$/.test(t));
    type Found = { forms: Map<string, number>; line: string; score: number; sources: InventorySource[]; count: number };
    const found = new Map<number, Found>();
    for (const c of chunks) {
      if (c.source === 'task' || c.source === 'project') continue;
      if (about.length && !about.every((t) => termsOf(c).has(t))) continue;
      scan(c.text, term, (raw, num, line) => {
        const item: Found = found.get(num) ?? { forms: new Map(), line: '', score: -1, sources: [], count: 0 };
        item.forms.set(raw, (item.forms.get(raw) ?? 0) + 1);
        item.count++;
        const s = lineScore(line);
        if (s > item.score) { item.score = s; item.line = line; }
        if (item.sources.length < 3 && !item.sources.some((x) => x.ref === c.ref && x.section === c.section)) {
          item.sources.push({ title: c.title, section: c.section, source: c.source, ref: c.ref });
        }
        found.set(num, item);
      });
    }
    // Una o dos coincidencias sueltas («evento 2026») no son una familia de identificadores.
    if (found.size < 2 || (best && found.size <= best.items.length)) continue;
    // Todos escritos igual, con la forma más habitual de la palabra en toda la documentación («eVar», no «evar_»).
    const prefixes = new Map<string, number>();
    for (const it of found.values()) for (const [raw, n] of it.forms) {
      const p = raw.replace(/\d+$/, '');
      prefixes.set(p, (prefixes.get(p) ?? 0) + n);
    }
    const prefix = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const items = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([num, it]) => ({
      id: `${prefix}${num}`, num, line: clip(it.line), sources: it.sources, count: it.count,
    }));
    best = { term, items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS, about };
  }
  return best;
}
