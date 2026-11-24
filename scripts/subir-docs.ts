// Sube la documentación del equipo (export HTML de Confluence) a Supabase. La corre UNA persona en su Mac:
//
//   npm run subir-docs -- dsub_<clave> <zip1> <zip2> ...      (guarda la clave la primera vez)
//   npm run subir-docs -- <zip1> <zip2> ...                   (usa la clave ya guardada)
//
// No usa contraseña ni la clave service_role: solo la «clave de subida» (dsub_…) que se genera en Ajustes → Documentación
// y la clave anon pública del .env. Abre los zips, saca el texto de cada página (como el conector MCP) y lo sube en lotes;
// el primero vacía lo anterior, así cada mes se sube el export completo. La clave se guarda en servidor/datos/docs-subida.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from '../src/features/docs/unzip.ts';
import { parseConfluencePage, type ConfluencePage } from '../src/domain/confluence.ts';
import { supabaseConfig } from './subir-onedrive.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.GESTOR_DATOS ? resolve(process.env.GESTOR_DATOS) : join(ROOT, 'servidor', 'datos');
const TOKEN_FILE = join(DATA_DIR, 'docs-subida.json');
const BATCH = 120;
const isHtml = (name: string) => /\.html?$/i.test(name) && !name.includes('__MACOSX');

function savedToken(): string | null {
  try { return (JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { token?: string }).token ?? null; } catch { return null; }
}
function saveToken(token: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
}

/** Lee los zips y devuelve las páginas (sin repetir por id). */
export async function pagesFromZips(paths: string[]): Promise<ConfluencePage[]> {
  const byId = new Map<string, ConfluencePage>();
  for (const p of paths) {
    const buf = readFileSync(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    for (const { name, text } of await unzip(ab, isHtml)) {
      const page = parseConfluencePage(text, name);
      if (page) byId.set(page.id, page);
    }
  }
  return [...byId.values()];
}

async function uploadBatch(cfg: { url: string; key: string }, token: string, docs: ConfluencePage[], reset: boolean): Promise<number> {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/upload_docs`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token, p_docs: docs, p_reset: reset }),
  });
  const body = (await res.json().catch(() => null)) as { message?: string; count?: number } | null;
  if (!res.ok) {
    const msg = body?.message ?? `Supabase ha respondido con un error (${res.status}).`;
    throw new Error(/upload_docs/.test(msg) ? 'Falta aplicar en Supabase la migración 014_documentacion.sql.' : msg);
  }
  return body?.count ?? 0;
}

async function main(argv: string[]) {
  let args = argv;
  if (args[0]?.startsWith('dsub_')) { saveToken(args[0]); console.log('Clave de subida guardada.'); args = args.slice(1); }
  const token = savedToken();
  if (!token) throw new Error('No hay clave de subida. Genera una en Ajustes → Documentación y pásala: npm run subir-docs -- dsub_... <zips>');
  if (!args.length) throw new Error('Dime los .zip del export de Confluence: npm run subir-docs -- <zip1> <zip2> ...');
  for (const p of args) if (!existsSync(p)) throw new Error(`No encuentro el archivo: ${p}`);

  const cfg = supabaseConfig();
  console.log('Abriendo los archivos…');
  const pages = await pagesFromZips(args);
  if (!pages.length) throw new Error('No he encontrado páginas. ¿Son export HTML de un espacio de Confluence?');
  console.log(`${pages.length} páginas. Subiendo…`);

  let count = 0;
  for (let i = 0; i < pages.length; i += BATCH) {
    count = await uploadBatch(cfg, token, pages.slice(i, i + BATCH), i === 0);
    console.log(`  ${Math.min(i + BATCH, pages.length)} / ${pages.length}`);
  }
  console.log(`Listo: ${count} páginas en la documentación.`);
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((e: Error) => { console.error('Error:', e.message); process.exit(1); });
}
