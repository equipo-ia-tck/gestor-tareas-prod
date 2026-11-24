// `npm run subir`: sube a Supabase las reuniones que Power Automate deja en OneDrive/Gestor/calendario.json, para que
// la app publicada (Vercel), que no ve las carpetas de este Mac, pueda enseñarlas. Ejecutado por Node 24 sin compilar.
//
//   npm run subir -- gsub_…      guarda la clave de subida (Ajustes → Calendario de Outlook) y empieza a vigilar el archivo
//   npm run subir                 vigila el archivo con la clave guardada y lo sube cada vez que cambia
//   npm run subir -- --una-vez    sube una vez y termina
//   npm run subir -- --instalar   lo deja en marcha siempre (al iniciar sesión en el Mac), con un LaunchAgent
//   npm run subir -- --desinstalar
//   (versión suelta: node subir-calendario.mjs gsub_… --instalar, y lo mismo con las demás opciones)
//
// Solo sube la lista de reuniones ya recortada (`trimOutlookEvents`: título, horas, asistentes, lugar, enlace y un
// resumen de la descripción). La clave se guarda en servidor/datos/subida.json (fuera de Git).
//
// Versión suelta, para quien no tiene el repositorio: al compilar, `scripts/build-subida.mjs` lo empaqueta en un solo
// archivo (`dist/subir-calendario.mjs`, se descarga en Ajustes) con la configuración de Supabase dentro
// (`globalThis.GESTOR_EMBEDDED`). Así guarda la clave y se instala en ~/Library/Application Support/Gestor.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimOutlookEvents } from '../src/domain/outlookEvents.ts';
import { findOutlookFile } from '../servidor/calendar.ts';

/** Configuración de Supabase que lleva dentro la versión suelta (null en el repositorio). */
const EMBEDDED = (globalThis as { GESTOR_EMBEDDED?: { url: string; key: string } }).GESTOR_EMBEDDED ?? null;
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const APP_DIR = join(homedir(), 'Library', 'Application Support', 'Gestor');
const DATA_DIR = process.env.GESTOR_DATOS ? resolve(process.env.GESTOR_DATOS) : EMBEDDED ? APP_DIR : join(ROOT, 'servidor', 'datos');
/** Cómo se lanza, para los mensajes. */
const CMD = EMBEDDED ? 'node subir-calendario.mjs' : 'npm run subir --';
const TOKEN_FILE = join(DATA_DIR, 'subida.json');
const LOG_FILE = join(DATA_DIR, 'subida.log');
const AGENT = 'com.gestor-tareas.subir';
const AGENT_FILE = join(homedir(), 'Library', 'LaunchAgents', `${AGENT}.plist`);
/** Cada cuánto se mira si el archivo ha cambiado (el flujo lo escribe cada 5 minutos). */
const EVERY_MS = 60_000;

type Fetch = typeof fetch;

/** Lee VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY del entorno o del .env del proyecto (la clave anon es pública). */
export function supabaseConfig(env: NodeJS.ProcessEnv = process.env, envFile = join(ROOT, '.env')): { url: string; key: string } {
  if (EMBEDDED && !env.VITE_SUPABASE_URL) return EMBEDDED;
  const vars: Record<string, string> = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const url = env.VITE_SUPABASE_URL ?? vars.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY ?? vars.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Falta la configuración de Supabase (.env: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY).');
  return { url: url.replace(/\/+$/, ''), key };
}

/** Sube las reuniones del archivo. Devuelve cuántas y el nombre de la cuenta que las recibe. */
export async function uploadCalendar(
  opts: { url: string; key: string; token: string; text: string; fileAt: Date },
  fetcher: Fetch = fetch,
): Promise<{ count: number; account: string }> {
  let json: unknown;
  try {
    json = JSON.parse(opts.text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('calendario.json no es JSON válido (¿el flujo lo está escribiendo en este momento?).');
  }
  const events = trimOutlookEvents(json);
  const res = await fetcher(`${opts.url}/rest/v1/rpc/upload_connector_file`, {
    method: 'POST',
    headers: { apikey: opts.key, Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: opts.token, p_kind: 'calendario', p_data: events, p_file_at: opts.fileAt.toISOString() }),
  });
  const body = await res.json().catch(() => null) as { message?: string } | string | null;
  if (!res.ok) {
    const msg = typeof body === 'object' && body?.message ? body.message : `Supabase ha respondido con un error (${res.status}).`;
    throw new Error(/upload_connector_file/.test(msg) ? 'Falta aplicar en Supabase la migración 005_calendario_subido.sql.' : msg);
  }
  return { count: events.length, account: typeof body === 'string' ? body : '' };
}

function savedToken(): string | null {
  try {
    return (JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

function saveToken(token: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
}

const now = () => new Date().toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const log = (msg: string) => console.log(`[${now()}] ${msg}`);

async function watch(token: string, once: boolean) {
  const config = supabaseConfig();
  let lastMtime = 0;
  let lastError = '';
  const tick = async () => {
    const path = findOutlookFile();
    if (!path) throw new Error('No encuentro Gestor/calendario.json en tu OneDrive (¿el flujo se ha ejecutado y OneDrive está sincronizado?).');
    const { mtime } = await stat(path);
    if (mtime.getTime() === lastMtime) return;
    const done = await uploadCalendar({ ...config, token, text: await readFile(path, 'utf8'), fileAt: mtime });
    lastMtime = mtime.getTime();
    log(`Subidas ${done.count} reuniones${done.account ? ` a la cuenta de ${done.account}` : ''} (archivo del ${mtime.toLocaleString('es-ES')}).`);
  };
  const run = async () => {
    try {
      await tick();
      lastError = '';
    } catch (e) {
      const msg = (e as Error).message;
      // Sin repetir el mismo error cada minuto.
      if (msg !== lastError) log(`Error: ${msg}`);
      lastError = msg;
      if (once || /Clave de subida no válida|migración/.test(msg)) {
        if (!once) log('Me paro: genera una clave nueva en Ajustes → Calendario de Outlook y vuelve a lanzar «${CMD} <clave>».');
        process.exitCode = 1;
        return false;
      }
    }
    return true;
  };
  if (!(await run()) || once) return;
  log(process.stdout.isTTY
    ? `Vigilando OneDrive/Gestor/calendario.json. Déjalo abierto (o usa «${CMD} --instalar»). Ctrl+C para parar.`
    : 'Vigilando OneDrive/Gestor/calendario.json.');
  const timer = setInterval(() => { void run().then((ok) => { if (!ok) clearInterval(timer); }); }, EVERY_MS);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function install() {
  if (process.platform !== 'darwin') throw new Error('--instalar solo funciona en macOS.');
  if (!savedToken()) throw new Error(`Primero guarda la clave: ${CMD} <clave> --instalar`);
  mkdirSync(dirname(AGENT_FILE), { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  // La versión suelta se copia a su carpeta fija: así da igual dónde se descargó (y se puede borrar de Descargas).
  let script = SELF;
  if (EMBEDDED) {
    script = join(APP_DIR, 'subir-calendario.mjs');
    if (resolve(SELF) !== script) copyFileSync(SELF, script);
  }
  const args = [process.execPath, script];
  writeFileSync(AGENT_FILE, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`);
  try { execFileSync('launchctl', ['unload', AGENT_FILE], { stdio: 'ignore' }); } catch { /* no estaba cargado */ }
  execFileSync('launchctl', ['load', AGENT_FILE]);
  console.log(`Instalado: se sube solo mientras tengas la sesión del Mac abierta. Registro en ${LOG_FILE}`);
  console.log('Si macOS pregunta si «node» puede acceder a OneDrive, di que sí.');
}

function uninstall() {
  if (existsSync(AGENT_FILE)) {
    try { execFileSync('launchctl', ['unload', AGENT_FILE], { stdio: 'ignore' }); } catch { /* ya parado */ }
    rmSync(AGENT_FILE);
  }
  console.log('Desinstalado: ya no se sube el calendario en segundo plano.');
}

async function main(argv: string[]) {
  if (argv.includes('--desinstalar')) return uninstall();
  const given = argv.find((a) => a.startsWith('gsub_'));
  if (given) {
    saveToken(given.trim());
    console.log(`Clave guardada en ${TOKEN_FILE}.`);
  }
  // Con la clave y --instalar a la vez: se guarda, se prueba una subida (así los errores se ven aquí) y se instala.
  if (argv.includes('--instalar')) {
    const token = given ?? savedToken();
    if (token) {
      await watch(token, true);
      if (process.exitCode) return console.error('No lo instalo hasta que la subida funcione.');
    }
    return install();
  }
  const token = given ?? savedToken();
  if (!token) {
    console.error(`Falta la clave de subida. En la app: Ajustes → Calendario de Outlook → «Generar clave de subida», y después:\n  ${CMD} <clave>`);
    process.exitCode = 1;
    return;
  }
  await watch(token, argv.includes('--una-vez'));
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
