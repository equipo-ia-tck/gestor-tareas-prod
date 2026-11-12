// Servidor del equipo: sirve la app compilada (dist/) en http://localhost:4173 y hace de puente con los conectores
// (Rally, Confluence, calendario, chats y Microsoft List). Los datos y las cuentas del equipo están en Supabase; aquí
// solo se guardan las claves de los conectores, en servidor/datos/equipo.sqlite (fuera de Git).
// Uso: `npm start` (compila y arranca). Para abrirlo a la red local: GESTOR_HOST=0.0.0.0 npm start.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './api.ts';
import { bearerOf, SupabaseAuth, supabaseConfig } from './auth.ts';
import { Calendar } from './calendar.ts';
import { Chats } from './chats.ts';
import { Confluence } from './confluence.ts';
import { MsList } from './msList.ts';
import { Rally } from './rally.ts';
import { rallyRoute } from './rallyRoutes.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA = process.env.GESTOR_DATOS ? resolve(process.env.GESTOR_DATOS) : join(ROOT, 'servidor', 'datos');
const PORT = Number(process.env.PORT ?? 4173);
const HOSTS = process.env.GESTOR_HOST ? [process.env.GESTOR_HOST] : ['127.0.0.1', '::1'];

mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(join(DATA, 'equipo.sqlite'));
const auth = new SupabaseAuth(supabaseConfig(ROOT));
const rally = new Rally(db);
const calendar = new Calendar(db);
const chats = new Chats(db);
const confluence = new Confluence(db);
const msList = new MsList(db);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024) throw new ApiError(413, 'Demasiados datos de golpe.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'La petición no es JSON válido.');
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname}`;
  // La sesión es la de Supabase: el servidor solo comprueba quién eres para usar tus conectores.
  const user = await auth.userFor(bearerOf(req.headers.authorization));
  if (!user) throw new ApiError(401, 'Inicia sesión.');
  if (url.pathname === '/api/rally' || url.pathname.startsWith('/api/rally/')) {
    return send(res, 200, await rallyRoute(rally, user, req.method ?? 'GET', url.pathname, url.searchParams, () => readJson(req)));
  }
  switch (route) {
    case 'GET /api/lista':
      return send(res, 200, msList.status(user));
    case 'POST /api/lista/link':
      return send(res, 200, msList.link(user));
    case 'POST /api/lista/unlink':
      return send(res, 200, msList.unlink(user));
    case 'GET /api/lista/items':
      return send(res, 200, await msList.items(user));
    case 'POST /api/lista/change':
      return send(res, 200, await msList.change(user, await readJson(req)));
    case 'GET /api/confluence':
      return send(res, 200, confluence.status(user));
    case 'POST /api/confluence/connect':
      return send(res, 200, await confluence.connect(user, await readJson(req)));
    case 'POST /api/confluence/disconnect':
      return send(res, 200, confluence.disconnect(user));
    case 'GET /api/confluence/tasks':
      return send(res, 200, { tasks: await confluence.tasks(user, { done: url.searchParams.get('done') }) });
    case 'GET /api/chats':
      return send(res, 200, chats.status(user));
    case 'POST /api/chats/link':
      return send(res, 200, chats.link(user));
    case 'POST /api/chats/unlink':
      return send(res, 200, chats.unlink(user));
    case 'GET /api/chats/data':
      return send(res, 200, await chats.chats(user));
    case 'GET /api/calendar':
      return send(res, 200, calendar.status(user));
    case 'POST /api/calendar/connect':
      return send(res, 200, await calendar.connect(user, await readJson(req)));
    case 'POST /api/calendar/disconnect':
      return send(res, 200, calendar.disconnect(user));
    case 'POST /api/calendar/file/link':
      return send(res, 200, calendar.linkFile(user));
    case 'POST /api/calendar/file/unlink':
      return send(res, 200, calendar.unlinkFile(user));
    case 'GET /api/calendar/events':
      return send(res, 200, await calendar.events(user));
    case 'GET /api/calendar/ics':
      return send(res, 200, { ics: await calendar.ics(user, url.searchParams.get('fresh') === '1') });
  }
  throw new ApiError(404, 'No existe.');
}

function serveStatic(res: ServerResponse, url: URL) {
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('La app no está compilada. Ejecuta `npm start`.');
  }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  const name = file.slice(DIST.length);
  // index.html y el service worker siempre frescos; los archivos con hash, en caché para siempre.
  const cache = name.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
  res.end(readFileSync(file));
}

const server = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url);
  handleApi(req, res, url).catch((e: unknown) => {
    if (e instanceof ApiError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Error del servidor. Mira la terminal.' });
  });
};

let started = 0;
for (const host of HOSTS) {
  createServer(server)
    .on('error', (e: NodeJS.ErrnoException) => {
      if (host === '::1' && e.code === 'EADDRNOTAVAIL') return; // sin IPv6: basta con 127.0.0.1
      console.error(`No se pudo abrir el puerto ${PORT} en ${host}: ${e.message}`);
      process.exitCode = 1;
    })
    .listen(PORT, host, () => {
      if (started++) return;
      console.log(`\n✓ Gestor del equipo en http://localhost:${PORT}`);
      console.log('  Datos y cuentas en Supabase; aquí, los conectores (Rally, Confluence, calendario, chats, lista).');
      console.log('  Deja esta ventana abierta mientras uséis la app.\n');
    });
}
