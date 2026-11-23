import type { KnowledgeDoc } from '../../domain/knowledge';

/**
 * Texto de un archivo para la documentación del Asistente, sacado en el navegador (no se sube el archivo, solo su texto):
 * texto y Markdown tal cual, HTML sin etiquetas, Word (.docx) leyendo su XML y PDF con pdf.js (se carga solo si hace falta).
 */

export interface Extracted { title: string; kind: KnowledgeDoc['kind']; body: string }

const MAX_FILE = 30 * 1024 * 1024;

export async function extractText(file: File): Promise<Extracted> {
  if (file.size > MAX_FILE) throw new Error(`«${file.name}» pesa ${Math.round(file.size / 1048576)} MB: el máximo es 30 MB.`);
  const name = file.name;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;
  let body: string;
  let kind: KnowledgeDoc['kind'];
  if (ext === 'pdf') { body = await pdfText(file); kind = 'pdf'; }
  else if (ext === 'docx') { body = await docxText(file); kind = 'word'; }
  else if (ext === 'md' || ext === 'markdown') { body = await file.text(); kind = 'markdown'; }
  else if (ext === 'html' || ext === 'htm') { body = htmlText(await file.text()); kind = 'other'; }
  else if (['txt', 'csv', 'json', 'log', 'tsv', 'xml', 'yml', 'yaml'].includes(ext) || file.type.startsWith('text/')) { body = await file.text(); kind = 'text'; }
  else if (ext === 'doc' || ext === 'ppt' || ext === 'pptx' || ext === 'xls' || ext === 'xlsx') {
    throw new Error(`«${name}»: este formato no se puede leer aquí. Guárdalo como PDF o Word (.docx), o pega el texto.`);
  } else throw new Error(`«${name}»: formato no admitido. Sube PDF, Word (.docx), Markdown, texto o HTML, o pega el texto.`);
  body = body.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new Error(`«${name}» no tiene texto (¿es un PDF escaneado como imagen?).`);
  return { title, kind, body };
}

function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((n) => n.remove());
  // Títulos y párrafos en líneas propias.
  doc.querySelectorAll('h1, h2, h3, h4').forEach((h) => { h.textContent = `\n# ${h.textContent?.trim() ?? ''}\n`; });
  doc.querySelectorAll('p, li, br, tr, div').forEach((n) => n.append('\n'));
  return doc.body.textContent ?? '';
}

/** PDF con pdf.js: el texto de cada página, juntando las líneas. */
async function pdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  return pages.join('\n\n');
}

/** Word (.docx): es un ZIP; se lee `word/document.xml` y se sacan los párrafos (los títulos, con «#»). */
async function docxText(file: File): Promise<string> {
  const xml = await unzipEntry(new Uint8Array(await file.arrayBuffer()), 'word/document.xml');
  if (!xml) throw new Error(`«${file.name}» no parece un Word (.docx) válido.`);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const out: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    let text = '';
    for (const n of Array.from(p.getElementsByTagNameNS(W, '*'))) {
      if (n.localName === 't') text += n.textContent ?? '';
      else if (n.localName === 'tab') text += '\t';
      else if (n.localName === 'br') text += '\n';
    }
    const style = p.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') ?? '';
    const level = /^(heading|titulo|título|ttulo)\s*(\d)/i.exec(style)?.[2] ?? (/^title$/i.test(style) ? '1' : null);
    out.push(level && text.trim() ? `${'#'.repeat(Number(level))} ${text.trim()}` : text);
  }
  return out.join('\n');
}

/** Un archivo de un ZIP (sin librerías: directorio central + DecompressionStream). */
export async function unzipEntry(zip: Uint8Array, path: string): Promise<string | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === path) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(start, start + size);
      if (method === 0) return decoder.decode(data);
      if (method !== 8) return null;
      const stream = new Blob([data.slice() as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
