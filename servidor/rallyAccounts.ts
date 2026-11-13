import type { DatabaseSync } from 'node:sqlite';

/** Cuenta de Rally de una persona del gestor: su clave de API y a quién corresponde en Rally. */
export interface RallyAccount { api_key: string; base_url: string; rally_user_id: string; rally_user: string }

/**
 * Dónde se guardan las claves de Rally. En el servidor local, en SQLite (`servidor/datos`); en Vercel, cifradas en
 * Supabase (`supabaseAccounts.ts`). Nunca vuelven al navegador.
 */
export interface RallyAccounts {
  get(userId: string): Promise<RallyAccount | undefined>;
  set(userId: string, account: RallyAccount): Promise<void>;
  remove(userId: string): Promise<void>;
}

export class SqliteRallyAccounts implements RallyAccounts {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS rally_accounts (user_id TEXT PRIMARY KEY, api_key TEXT NOT NULL, base_url TEXT NOT NULL,
      rally_user_id TEXT NOT NULL, rally_user TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  async get(userId: string) {
    return this.db.prepare('SELECT api_key, base_url, rally_user_id, rally_user FROM rally_accounts WHERE user_id = ?').get(userId) as
      RallyAccount | undefined;
  }

  async set(userId: string, a: RallyAccount) {
    this.db.prepare(`INSERT INTO rally_accounts (user_id, api_key, base_url, rally_user_id, rally_user, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key, base_url = excluded.base_url, rally_user_id = excluded.rally_user_id,
      rally_user = excluded.rally_user, updated_at = excluded.updated_at`)
      .run(userId, a.api_key, a.base_url, a.rally_user_id, a.rally_user, new Date().toISOString());
  }

  async remove(userId: string) {
    this.db.prepare('DELETE FROM rally_accounts WHERE user_id = ?').run(userId);
  }
}
