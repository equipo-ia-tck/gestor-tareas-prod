import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './api.ts';
import type { TeamUser } from './auth.ts';
import { downloadIcs, normalizeIcsUrl } from './calendar.ts';

/**
 * Otro calendario por su enlace ICS publicado (p. ej. el de La Caixa, que sí trae los títulos), además del de Outlook
 * de WPP. Funciona igual en el servidor del Mac y en Vercel (`api/calendario-extra.ts`): el servidor descarga el .ics
 * (el navegador no puede por CORS), lo recorta a las reuniones cercanas y lo devuelve; la app lo lee con `parseIcs`.
 * El enlace da acceso al calendario: se guarda en el servidor (en Vercel, cifrado en Supabase) y nunca vuelve al
 * navegador.
 */

type Fetch = typeof fetch;

export interface IcsAccount { url: string; name: string }

/** Dónde se guarda el enlace de cada persona: SQLite en el Mac, Supabase cifrado en Vercel. */
export interface IcsAccounts {
  get(userId: string): Promise<IcsAccount | undefined>;
  set(userId: string, account: IcsAccount): Promise<void>;
  remove(userId: string): Promise<void>;
}

export interface IcsExtraStatus { connected: boolean; name: string | null; host: string | null }

export class SqliteIcsAccounts implements IcsAccounts {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS ics_extra_accounts (user_id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL)');
  }

  async get(userId: string) {
    return this.db.prepare('SELECT url, name FROM ics_extra_accounts WHERE user_id = ?').get(userId) as IcsAccount | undefined;
  }

  async set(userId: string, a: IcsAccount) {
    this.db.prepare(`INSERT INTO ics_extra_accounts (user_id, url, name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET url = excluded.url, name = excluded.name, updated_at = excluded.updated_at`)
      .run(userId, a.url, a.name, new Date().toISOString());
  }

  async remove(userId: string) {
    this.db.prepare('DELETE FROM ics_extra_accounts WHERE user_id = ?').run(userId);
  }
}

/** Días que se devuelven alrededor de hoy (las recurrentes se dejan siempre: se expanden en la app). */
const PAST_DAYS = 45;
const FUTURE_DAYS = 120;

/**
 * Deja solo las reuniones cercanas, para no pasar el límite de respuesta de Vercel con años de historial: las
 * recurrentes (RRULE) y sus excepciones siempre, el resto si empiezan entre `from` y `to` ("YYYYMMDD"). Conserva la
 * cabecera y las zonas horarias.
 */
export function trimIcs(text: string, from: string, to: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let block: string[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { block = [line]; continue; }
    if (block) {
      block.push(line);
      if (/^END:VEVENT/i.test(line)) {
        const body = block.join('\n');
        const start = /^DTSTART[^:\n]*:(\d{8})/im.exec(body)?.[1] ?? '';
        const keep = /^(RRULE|RECURRENCE-ID)[;:]/im.test(body) || (start >= from && start <= to);
        if (keep) out.push(...block);
        block = null;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\r\n');
}

const compact = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

const cleanName = (raw: unknown) => String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'Otro calendario';

export class IcsExtra {
  private accounts: IcsAccounts;
  private fetch: Fetch;

  constructor(accounts: IcsAccounts, fetcher: Fetch = fetch) {
    this.accounts = accounts;
    this.fetch = fetcher;
  }

  async status(user: TeamUser): Promise<IcsExtraStatus> {
    const a = await this.accounts.get(user.id);
    return { connected: !!a, name: a?.name ?? null, host: a ? new URL(a.url).hostname : null };
  }

  /** Comprueba que el enlace devuelve un calendario y lo guarda con su nombre. */
  async connect(user: TeamUser, input: { url?: unknown; name?: unknown }): Promise<IcsExtraStatus> {
    const url = normalizeIcsUrl(input.url);
    await downloadIcs(this.fetch, url);
    await this.accounts.set(user.id, { url, name: cleanName(input.name) });
    return this.status(user);
  }

  async disconnect(user: TeamUser): Promise<IcsExtraStatus> {
    await this.accounts.remove(user.id);
    return this.status(user);
  }

  /** El .ics recortado a las reuniones cercanas, con el nombre del calendario. */
  async ics(user: TeamUser, now = new Date()): Promise<{ name: string; ics: string }> {
    const a = await this.accounts.get(user.id);
    if (!a) throw new ApiError(400, 'Conecta el otro calendario en Ajustes.');
    const text = await downloadIcs(this.fetch, a.url);
    const day = 86_400_000;
    return { name: a.name, ics: trimIcs(text, compact(new Date(now.getTime() - PAST_DAYS * day)), compact(new Date(now.getTime() + FUTURE_DAYS * day))) };
  }
}

type Body = () => Promise<Record<string, unknown>>;

/** Rutas `/api/calendario-extra…`, iguales en el servidor del Mac y en Vercel. */
export async function icsExtraRoute(cal: IcsExtra, user: TeamUser, method: string, path: string, readBody: Body): Promise<unknown> {
  switch (`${method} ${path}`) {
    case 'GET /api/calendario-extra':
      return cal.status(user);
    case 'POST /api/calendario-extra/connect':
      return cal.connect(user, await readBody());
    case 'POST /api/calendario-extra/disconnect':
      return cal.disconnect(user);
    case 'GET /api/calendario-extra/ics':
      return cal.ics(user);
  }
  throw new ApiError(404, 'No existe.');
}
