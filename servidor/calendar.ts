import { isSamePerson } from './previousAccount.ts';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { trimOutlookEvents, type OutlookEvent } from '../src/domain/outlookEvents.ts';
import { ApiError } from './api.ts';
import type { TeamUser } from './auth.ts';

/**
 * Calendario de Outlook/Teams por su enlace ICS publicado (Outlook → Configuración → Calendario → Calendarios
 * compartidos → Publicar un calendario). Sin permisos de Microsoft: el servidor descarga el .ics (el navegador no
 * puede por CORS) y la app lo lee con `parseIcs`. El enlace da acceso al calendario, así que solo se guarda aquí y
 * nunca vuelve al navegador. Solo lectura.
 *
 * Si la empresa solo deja publicar la disponibilidad (sin títulos), hay una segunda fuente: un flujo de Power Automate
 * que guarda las reuniones en `OneDrive/Gestor/calendario.json`; OneDrive lo sincroniza a este ordenador y el servidor
 * lo lee de la carpeta local. Se vincula a una sola cuenta (es el calendario de quien tiene el OneDrive).
 */

type Fetch = typeof fetch;

export interface CalendarStatus {
  connected: boolean;
  /** Servidor del enlace (p. ej. "outlook.office365.com"), para reconocerlo sin enseñar el enlace. */
  host: string | null;
  /** Archivo del flujo de Power Automate: vinculado a esta cuenta y encontrado en este ordenador. */
  file: { linked: boolean; found: boolean };
}

/**
 * Archivo que escribe un flujo de Power Automate en `Gestor/<nombre>` de la carpeta de OneDrive sincronizada (o la ruta
 * de la variable de entorno `env`, para pruebas).
 */
export function findGestorFile(name: string, env: string, home = homedir()): string | null {
  const forced = process.env[env];
  if (forced) return existsSync(forced) ? forced : null;
  const cloud = join(home, 'Library', 'CloudStorage');
  let dirs: string[] = [];
  try { dirs = readdirSync(cloud).filter((d) => d.startsWith('OneDrive')); } catch { /* sin OneDrive */ }
  for (const d of dirs) {
    const file = join(cloud, d, 'Gestor', name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Archivo de reuniones: `GESTOR_CALENDARIO` o `Gestor/calendario.json` en OneDrive. */
export const findOutlookFile = (home = homedir()) => findGestorFile('calendario.json', 'GESTOR_CALENDARIO', home);

/** Tiempo que se reutiliza el calendario descargado (salvo que se pida refrescar). */
const CACHE_MS = 5 * 60_000;
const MAX_BYTES = 20 * 1024 * 1024;

/** Enlace ICS válido: https (webcal:// se trata como https) y a un servidor público con nombre, no a una IP ni a localhost. */
export function normalizeIcsUrl(raw: unknown): string {
  const text = String(raw ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError(400, 'Pega el enlace ICS completo (empieza por https://).');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new ApiError(400, 'El enlace tiene que empezar por https://.');
  if (isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || host.endsWith('.local') || !host.includes('.')) {
    throw new ApiError(400, 'Ese enlace no es de un calendario publicado.');
  }
  return url.toString();
}

export class Calendar {
  private db: DatabaseSync;
  private fetch: Fetch;
  private cache = new Map<string, { url: string; at: number; text: string }>();
  private findFile: () => string | null;
  private fileCache: { path: string; mtime: number; events: OutlookEvent[] } | null = null;

  constructor(db: DatabaseSync, fetcher: Fetch = fetch, findFile: () => string | null = findOutlookFile) {
    this.db = db;
    this.fetch = fetcher;
    this.findFile = findFile;
    db.exec('CREATE TABLE IF NOT EXISTS calendar_accounts (user_id TEXT PRIMARY KEY, ics_url TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS calendar_files (user_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL)');
  }

  private linkedFile(user: TeamUser): string | null {
    const row = this.db.prepare('SELECT path FROM calendar_files WHERE user_id = ?').get(user.id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  private url(user: TeamUser): string | null {
    const row = this.db.prepare('SELECT ics_url FROM calendar_accounts WHERE user_id = ?').get(user.id) as { ics_url: string } | undefined;
    return row?.ics_url ?? null;
  }

  status(user: TeamUser): CalendarStatus {
    const url = this.url(user);
    const linked = this.linkedFile(user);
    return {
      connected: !!url,
      host: url ? new URL(url).hostname : null,
      file: { linked: !!linked, found: !!(linked ? existsSync(linked) : this.findFile()) },
    };
  }

  /** Vincula a esta cuenta el archivo del flujo que hay en este ordenador (si no lo tiene ya otra cuenta). */
  linkFile(user: TeamUser): CalendarStatus {
    const path = this.findFile();
    if (!path) throw new ApiError(400, 'No encuentro Gestor/calendario.json en tu OneDrive. Comprueba que el flujo se ha ejecutado y que OneDrive está sincronizado.');
    const owner = this.db.prepare('SELECT user_id FROM calendar_files WHERE path = ?').get(path) as { user_id: string } | undefined;
    if (owner && !isSamePerson(this.db, owner.user_id, user)) throw new ApiError(400, 'Ese calendario ya está vinculado a otra cuenta.');
    // Era de su cuenta de antes de Supabase: pasa a la de ahora.
    if (owner && owner.user_id !== user.id) this.db.prepare('DELETE FROM calendar_files WHERE user_id = ?').run(owner.user_id);
    this.db.prepare(`INSERT INTO calendar_files (user_id, path, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`).run(user.id, path, new Date().toISOString());
    return this.status(user);
  }

  unlinkFile(user: TeamUser): CalendarStatus {
    this.db.prepare('DELETE FROM calendar_files WHERE user_id = ?').run(user.id);
    return this.status(user);
  }

  /** Reuniones del archivo del flujo (se vuelve a leer solo cuando cambia) y cuándo lo escribió el flujo por última vez. */
  async events(user: TeamUser): Promise<{ events: OutlookEvent[]; updatedAt: string }> {
    const path = this.linkedFile(user);
    if (!path) throw new ApiError(400, 'Vincula el archivo de Power Automate.');
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      throw new ApiError(400, 'El archivo del calendario ya no está en tu OneDrive.');
    }
    if (this.fileCache?.path !== path || this.fileCache.mtime !== mtime) {
      let json: unknown;
      try {
        json = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
      } catch {
        throw new ApiError(502, 'El archivo del calendario no es JSON válido (¿el flujo está escribiendo la lista de reuniones?).');
      }
      this.fileCache = { path, mtime, events: trimOutlookEvents(json) };
    }
    return { events: this.fileCache.events, updatedAt: new Date(mtime).toISOString() };
  }

  private async download(url: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { Accept: 'text/calendar, text/plain, */*' }, redirect: 'follow' });
    } catch {
      throw new ApiError(502, 'No se puede descargar el calendario. Revisa la conexión y el enlace.');
    }
    if (res.status === 404 || res.status === 410) throw new ApiError(400, 'El enlace ya no existe: vuelve a publicar el calendario en Outlook y pega el nuevo.');
    if (!res.ok) throw new ApiError(502, `Outlook ha respondido con un error (${res.status}).`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new ApiError(502, 'El calendario es demasiado grande.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new ApiError(400, 'Ese enlace no devuelve un calendario. Copia el enlace ICS, no el HTML.');
    return text;
  }

  /** Comprueba que el enlace devuelve un calendario y lo guarda. */
  async connect(user: TeamUser, input: { url?: unknown }): Promise<CalendarStatus> {
    const url = normalizeIcsUrl(input.url);
    const text = await this.download(url);
    this.db.prepare(`INSERT INTO calendar_accounts (user_id, ics_url, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET ics_url = excluded.ics_url, updated_at = excluded.updated_at`)
      .run(user.id, url, new Date().toISOString());
    this.cache.set(user.id, { url, at: Date.now(), text });
    return this.status(user);
  }

  disconnect(user: TeamUser): CalendarStatus {
    this.db.prepare('DELETE FROM calendar_accounts WHERE user_id = ?').run(user.id);
    this.cache.delete(user.id);
    return this.status(user);
  }

  /** El .ics del usuario (de la caché si es reciente y no se pide refrescar). */
  async ics(user: TeamUser, fresh = false): Promise<string> {
    const url = this.url(user);
    if (!url) throw new ApiError(400, 'Conecta tu calendario de Outlook.');
    const hit = this.cache.get(user.id);
    if (!fresh && hit && hit.url === url && Date.now() - hit.at < CACHE_MS) return hit.text;
    const text = await this.download(url);
    this.cache.set(user.id, { url, at: Date.now(), text });
    return text;
  }
}
