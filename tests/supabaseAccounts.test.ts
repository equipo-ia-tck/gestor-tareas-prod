import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, SupabaseRallyAccounts } from '../servidor/supabaseAccounts.ts';

describe('claves de Rally cifradas en Supabase', () => {
  it('cifra y descifra; con otro secreto no se puede leer', () => {
    const c = encrypt('clave-de-rally', 'secreto-1');
    expect(c).not.toContain('clave-de-rally');
    expect(decrypt(c, 'secreto-1')).toBe('clave-de-rally');
    expect(() => decrypt(c, 'otro')).toThrow();
    expect(encrypt('x', 's')).not.toBe(encrypt('x', 's'));
  });

  it('guarda solo el texto cifrado y lo lee con la sesión de la persona', async () => {
    const stored = new Map<string, { secret: string; info: Record<string, unknown> }>();
    const calls: { fn: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ fn, auth: new Headers(init.headers).get('authorization') });
      if (fn === 'set_my_connector') stored.set('rally', { secret: String(args.p_secret), info: args.p_info as Record<string, unknown> });
      if (fn === 'delete_my_connector') stored.delete('rally');
      const body = fn === 'my_connector' ? JSON.stringify(stored.get('rally') ?? null) : '';
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const accounts = new SupabaseRallyAccounts({ url: 'https://x.supabase.co', key: 'anon' }, 'token-de-marta', 'secreto', fakeFetch);
    await accounts.set('u', { api_key: '_clave', base_url: 'https://eu1.rallydev.com', rally_user_id: '1', rally_user: 'Marta' });
    expect(stored.get('rally')!.secret).not.toContain('_clave');
    expect(await accounts.get()).toEqual({ api_key: '_clave', base_url: 'https://eu1.rallydev.com', rally_user_id: '1', rally_user: 'Marta' });
    expect(calls.every((c) => c.auth === 'Bearer token-de-marta')).toBe(true);
    // Con otro secreto (p. ej. si se cambia en Vercel) no se lee: hay que volver a conectar.
    expect(await new SupabaseRallyAccounts({ url: 'https://x.supabase.co', key: 'anon' }, 't', 'otro', fakeFetch).get()).toBeUndefined();
    await accounts.remove();
    expect(await accounts.get()).toBeUndefined();
  });
});
