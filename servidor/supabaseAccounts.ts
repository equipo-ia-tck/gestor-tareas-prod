import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './api.ts';
import type { RallyAccount, RallyAccounts } from './rallyAccounts.ts';

type Fetch = typeof fetch;

/** Cifra con AES-256-GCM; la clave sale del secreto (RALLY_SECRET), que solo tiene la función de Vercel. */
export function encrypt(plain: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decrypt(text: string, secret: string): string {
  if (!text.startsWith('v1:')) throw new Error('Formato de clave desconocido.');
  const raw = Buffer.from(text.slice(3), 'base64');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Claves de Rally guardadas en Supabase (`connector_accounts`, migración 004), cifradas. Se usan con la sesión de la
 * persona: Supabase solo deja leer, guardar o borrar la suya.
 */
export class SupabaseRallyAccounts implements RallyAccounts {
  private url: string;
  private key: string;
  private token: string;
  private secret: string;
  private fetch: Fetch;

  constructor(config: { url: string; key: string }, token: string, secret: string, fetchImpl: Fetch = fetch) {
    this.url = config.url;
    this.key = config.key;
    this.token = token;
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(`${this.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: this.key, Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch {
      throw new ApiError(503, 'No se puede conectar con Supabase.');
    }
    if (res.status === 404) throw new ApiError(503, 'Falta preparar la base de datos para los conectores (migración 004).');
    if (!res.ok) throw new ApiError(502, `Supabase ha respondido con un error (${res.status}).`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async get(): Promise<RallyAccount | undefined> {
    const row = await this.rpc('my_connector', { p_connector: 'rally' }) as { secret: string; info: Partial<RallyAccount> } | null;
    if (!row?.secret) return undefined;
    let apiKey: string;
    try {
      apiKey = decrypt(row.secret, this.secret);
    } catch {
      return undefined; // cifrada con otro secreto: hay que volver a conectar
    }
    return { api_key: apiKey, base_url: String(row.info.base_url ?? ''), rally_user_id: String(row.info.rally_user_id ?? ''), rally_user: String(row.info.rally_user ?? '') };
  }

  async set(_userId: string, a: RallyAccount) {
    await this.rpc('set_my_connector', {
      p_connector: 'rally',
      p_secret: encrypt(a.api_key, this.secret),
      p_info: { base_url: a.base_url, rally_user_id: a.rally_user_id, rally_user: a.rally_user },
    });
  }

  async remove() {
    await this.rpc('delete_my_connector', { p_connector: 'rally' });
  }
}
