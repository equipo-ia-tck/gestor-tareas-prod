// Lo usa el conector MCP (Node sin empaquetar) y la subida en el navegador: los imports de valores llevan `.ts`.
import { splitSections, type Chunk } from './knowledge.ts';

/**
 * Lee el export HTML de un espacio de Confluence (una página por fichero) y lo convierte en texto buscable. El equipo
 * descarga el export una vez al mes (aprobado por José y Mati; solo cómo trabaja el equipo y para qué sirve cada cosa, sin
 * documentación privada del cliente), un administrador lo sube en Ajustes → Documentación y el MCP lo busca. Funciones
 * puras, sin DOM: el mismo código corre en el navegador (al subir) y en el servidor (los tests), sin depender de DOMParser.
 */

/** Confluence Data Center de CaixaBank. Solo se llega desde su red; el enlace sirve para citar, no para que lo abra el MCP. */
export const CONFLUENCE_BASE = 'https://confluence.cloud.lacaixa.es/confluence';

export interface ConfluencePage {
  /** Id de la página en Confluence (sale del nombre del fichero). */
  id: string;
  /** Espacio al que pertenece. */
  space: string;
  title: string;
  /** Migas de pan: Espacio › Sección › … › Página. */
  path: string;
  /** Enlace a la página en Confluence. */
  url: string;
  /** Texto de la página, ya sin HTML. */
  body: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', raquo: '»', laquo: '«',
};

/** Descodifica las entidades HTML (&amp;, &#39;, &#x1f3e0;…). */
function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Convierte un trozo de HTML en texto plano, conservando saltos de párrafo, listas y encabezados (como «#»). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|blockquote|section|header|dd|dt)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s);
  return s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** El id de la página sale del final del nombre del fichero: `Owners-de-etiquetado_4511892904.html` → `4511892904`. */
export function pageIdFromName(fileName: string): string {
  const base = fileName.replace(/^.*\//, '').replace(/\.html?$/i, '');
  return /_(\d+)$/.exec(base)?.[1] ?? (/^\d+$/.test(base) ? base : base);
}

function section(html: string, startRe: RegExp, endRe: RegExp): string | null {
  const a = startRe.exec(html);
  if (!a) return null;
  const from = a.index + a[0].length;
  const rest = html.slice(from);
  const b = endRe.exec(rest);
  return b ? rest.slice(0, b.index) : rest;
}

/**
 * Lee una página del export. Devuelve `null` si no tiene cuerpo (índices, páginas vacías). `fileName` da el id y `base` es
 * la dirección de Confluence para construir el enlace.
 */
export function parseConfluencePage(html: string, fileName: string, base = CONFLUENCE_BASE): ConfluencePage | null {
  const id = pageIdFromName(fileName);
  const rawTitle = section(html, /id="title-text"[^>]*>/i, /<\/(span|h1)>/i);
  if (rawTitle == null) return null;
  const full = htmlToText(rawTitle).replace(/\s+/g, ' ').trim();
  const sep = full.indexOf(' : ');
  const space = sep >= 0 ? full.slice(0, sep).trim() : '';
  const title = (sep >= 0 ? full.slice(sep + 3) : full).trim();
  if (!title) return null;

  const crumbs = section(html, /id="breadcrumbs"[^>]*>/i, /<\/ol>/i) ?? '';
  const labels = [...crumbs.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => htmlToText(m[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const main = section(html, /id="main-content"[^>]*>/i, /<div id="(footer|likes-and-labels)"/i);
  const body = main ? htmlToText(main) : '';
  if (!body) return null;

  return {
    id,
    space,
    title,
    path: [...labels, title].join(' › '),
    url: `${base.replace(/\/$/, '')}/pages/viewpage.action?pageId=${id}`,
    body,
  };
}

/** Trozos buscables de una página (por apartados), con fuente `doc` y el id de la página como `ref`. */
export function pageChunks(page: ConfluencePage): Chunk[] {
  const secs = splitSections(page.body);
  const parts = secs.length ? secs : [{ section: '', text: page.body }];
  return parts.map((s, i) => ({
    id: `doc:${page.id}:${i}`,
    source: 'doc' as const,
    ref: page.id,
    title: page.title,
    section: s.section || undefined,
    text: s.text,
  }));
}

/**
 * Trozos de las páginas para el Asistente de la app: los de `pageChunks`, con id `cf:` (para no chocar con los de las
 * carpetas de SharePoint) y el enlace de la página como `ref`, así citarlos lleva a Confluence. La ruta va al final del
 * texto para que también se encuentre por el espacio o la sección.
 */
export function confluenceChunks(pages: ConfluencePage[]): Chunk[] {
  return pages.flatMap((p) => pageChunks(p).map((c) => ({
    ...c,
    id: `cf:${c.id}`,
    ref: p.url,
    text: p.path ? `${c.text}\n(${p.path})` : c.text,
  })));
}

/** ¿Este trozo es de la documentación de Confluence? */
export const isConfluenceChunk = (c: Chunk) => c.id.startsWith('cf:');
