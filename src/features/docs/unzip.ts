/**
 * Descomprime un .zip en el navegador sin librerías: lee el directorio central del ZIP y descomprime cada entrada con
 * `DecompressionStream` (nativo en Chrome). Pensado para los export HTML de Confluence (zips pequeños, método deflate o
 * guardado, sin ZIP64). Devuelve solo los ficheros que pide `keep`, ya como texto UTF-8.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

async function inflate(method: number, bytes: Uint8Array): Promise<Uint8Array> {
  if (method === 0) return bytes; // guardado, sin comprimir
  if (method !== 8) throw new Error(`Compresión ZIP no soportada (método ${method}).`);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  name: string;
  text: string;
}

/** Entradas del zip cuyo nombre cumple `keep` (por defecto, todas), descomprimidas a texto. */
export async function unzip(buffer: ArrayBuffer, keep: (name: string) => boolean = () => true): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // El directorio central está al final; busco la firma del EOCD hacia atrás (puede haber comentario después).
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0 && i >= buffer.byteLength - 22 - 0x10000; i--) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No parece un archivo ZIP válido.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // offset del directorio central
  const dec = new TextDecoder('utf-8');
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buffer.byteLength; i++) {
    if (view.getUint32(p, true) !== CENTRAL) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!keep(name)) continue;
    // El dato empieza tras la cabecera local (cuyas longitudes de nombre/extra pueden diferir de las del directorio).
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const data = await inflate(method, bytes.subarray(start, start + compSize));
    out.push({ name, text: dec.decode(data) });
  }
  return out;
}
