import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Prueba la base de datos de Supabase (supabase/migrations) en un Postgres de verdad (PGlite), imitando
 * lo mínimo de Supabase: roles anon/authenticated y auth.uid()/auth.email() de la sesión.
 */
const MIGRATION = ['001_equipo.sql', '002_baja_y_contrasenas.sql', '003_alta_sin_invitacion.sql', '004_claves_conectores.sql'].map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');
let db: PGlite;

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create schema extensions;
  create table auth.users (id uuid primary key, email text, encrypted_password text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.email() returns text language sql stable as $$ select nullif(current_setting('test.email', true), '') $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid(), auth.email() to authenticated, anon;
  grant usage on schema public to authenticated, anon;
`;

interface User { id: string; email: string }
let n = 0;
async function newUser(email: string): Promise<User> {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  await db.query('reset role');
  await db.query('insert into auth.users values ($1, $2)', [id, email]);
  return { id, email };
}
async function as<T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`reset role; select set_config('test.uid', '${u.id}', false); select set_config('test.email', '${u.email}', false); set role authenticated;`);
  return (await db.query<T>(sql, params)).rows;
}
const rpc = async (u: User, fn: string, args: Record<string, unknown> = {}) => {
  const names = Object.keys(args);
  const rows = await as<{ r: unknown }>(u, `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, names.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }));
  return rows[0].r as never;
};
const push = (u: User, changes: object[]) => rpc(u, 'push_changes', { p_changes: changes }) as Promise<{ rejected: string[] }>;
const visible = async (u: User) => (await as<{ id: string }>(u, `select tbl || ':' || key as id from records where data is not null order by 1`)).map((r) => r.id);
const task = (id: string, extra: object = {}) => ({ id, title: id, people: [], project_id: null, my_day: null, remind_at: null, ...extra });

beforeEach(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  await db.exec(MIGRATION);
});

describe('base de datos del equipo en Supabase', () => {
  it('la primera cuenta es administradora; las demás entran con invitación de un espacio', async () => {
    const marta = await newUser('marta@vml.com');
    const me = await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' }) as { isAdmin: boolean; adminCode: string };
    expect(me.isAdmin).toBe(true);
    const spaces = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    const markMe = await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: spaces[0].inviteCode.toLowerCase() }) as { isAdmin: boolean; spaces: unknown[] };
    expect(markMe.isAdmin).toBe(false);
    expect(markMe.spaces).toHaveLength(1);
    const ana = await newUser('ana@vml.com');
    expect((await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: me.adminCode }) as { isAdmin: boolean }).isAdmin).toBe(true);
  });

  it('privado por defecto; espacio y mención comparten; Mi día es de cada uno', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { id: string; inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    const uri = await newUser('uri@vml.com');
    await rpc(uri, 'register_profile', { p_name: 'Uri Soler', p_code: exc.inviteCode });
    await rpc(uri, 'remove_member', { p_space: exc.id, p_user: null }); // Uri sale del espacio

    await push(marta, [
      { tbl: 'projects', key: 'p', data: { id: 'p', name: 'Revisiones', parent_id: null, space_id: exc.id } },
      { tbl: 'projects', key: 'sub', data: { id: 'sub', name: 'Uri', parent_id: 'p' } },
      { tbl: 'tasks', key: 'del-espacio', data: task('del-espacio', { project_id: 'sub' }) },
      { tbl: 'projects', key: 'priv', data: { id: 'priv', name: 'Privado', parent_id: null } },
      { tbl: 'tasks', key: 'privada', data: task('privada', { project_id: 'priv' }) },
      { tbl: 'tasks', key: 'para-uri', data: task('para-uri', { project_id: 'priv', people: ['uri soler'], my_day: '2026-10-23' }) },
      { tbl: 'tasks', key: 'nombre-de-pila', data: task('nombre-de-pila', { people: ['Uri'] }) },
      { tbl: 'people', key: 'Mike', data: { name: 'Mike' } },
    ]);
    expect(await visible(mark)).toEqual(['projects:p', 'projects:sub', 'tasks:del-espacio']);
    expect(await visible(uri)).toEqual(['projects:priv', 'tasks:para-uri']);
    expect((await visible(marta)).length).toBe(8);
    // "Mi día" no viaja en la tarea: es un overlay de quien lo puso.
    expect((await as<{ d: unknown }>(uri, `select data->'my_day' as d from records where key = 'para-uri'`))[0].d).toBeNull();
    expect(await as(marta, `select key from overlays`)).toEqual([{ key: 'para-uri' }]);
    expect(await as(uri, `select key from overlays`)).toEqual([]);
  });

  it('no se puede escribir lo ajeno ni directamente en las tablas; la config común solo administradores', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { id: string; inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    await push(marta, [{ tbl: 'tasks', key: 'secreta', data: task('secreta') }]);
    const r = await push(mark, [
      { tbl: 'tasks', key: 'secreta', data: task('secreta', { title: 'hack' }) },
      { tbl: 'item_types', key: 'us', data: { id: 'us', name: 'X' } },
    ]);
    expect(r.rejected).toEqual(['tasks:secreta', 'item_types:us']);
    await expect(as(mark, `insert into records (tbl, key, data) values ('tasks', 'x', '{}')`)).rejects.toThrow();
    await expect(as(mark, `update profiles set is_admin = true`)).rejects.toThrow();
    // Un proyecto solo se lleva a un espacio propio.
    const otro = await newUser('otro@vml.com');
    await rpc(otro, 'register_profile', { p_name: 'Otro', p_code: (await rpc(marta, 'me') as { adminCode: string }).adminCode });
    const r2 = await push(otro, [{ tbl: 'projects', key: 'x', data: { id: 'x', name: 'X', parent_id: null, space_id: exc.id } }]);
    expect(r2.rejected).toEqual(['projects:x']);
  });

  it('mover un proyecto de espacio recalcula lo que cuelga y avisa a quien deja de verlo', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { id: string; inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    // La tarea llega antes que su proyecto (como al subir todo de golpe).
    await push(marta, [{ tbl: 'tasks', key: 't', data: task('t', { project_id: 'p' }) }]);
    await push(marta, [{ tbl: 'projects', key: 'p', data: { id: 'p', name: 'P', parent_id: null, space_id: exc.id } }]);
    expect(await visible(mark)).toEqual(['projects:p', 'tasks:t']);
    const before = (await rpc(mark, 'me') as { accessVersion: number }).accessVersion;
    await push(marta, [{ tbl: 'projects', key: 'p', data: { id: 'p', name: 'P', parent_id: null, space_id: null } }]);
    expect(await visible(mark)).toEqual([]);
    expect((await rpc(mark, 'me') as { accessVersion: number }).accessVersion).toBeGreaterThan(before);
  });

  it('administración: roles, desactivar y siempre un administrador', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { id: string; inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    await expect(rpc(mark, 'admin_overview')).rejects.toThrow(/administra/);
    await expect(rpc(mark, 'create_space', { p_name: 'X', p_color: null })).rejects.toThrow(/administra/);
    await rpc(marta, 'set_admin', { p_user: mark.id, p_value: true });
    await rpc(mark, 'set_admin', { p_user: marta.id, p_value: false });
    await expect(rpc(mark, 'set_admin', { p_user: mark.id, p_value: false })).rejects.toThrow(/al menos una/);
    await rpc(mark, 'set_disabled', { p_user: marta.id, p_value: true });
    expect(await visible(marta)).toEqual([]);
    await expect(push(marta, [{ tbl: 'tasks', key: 'a', data: task('a') }])).rejects.toThrow(/activa/);
    const code = await rpc(mark, 'regenerate_admin_code');
    expect((await rpc(mark, 'admin_overview') as { adminCode: string }).adminCode).toBe(code);
  });

  it('darse de baja: borra lo privado, deja lo del espacio y pasa la administración', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { id: string; inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    await push(mark, [
      { tbl: 'projects', key: 'p', data: { id: 'p', name: 'Común', parent_id: null, space_id: exc.id } },
      { tbl: 'tasks', key: 'comun', data: task('comun', { project_id: 'p' }) },
      { tbl: 'tasks', key: 'privada', data: task('privada') },
      { tbl: 'tasks', key: 'mencion', data: task('mencion', { people: ['Marta García'] }) },
    ]);
    // Mark no es administrador de la herramienta: puede darse de baja.
    await rpc(mark, 'delete_my_account');
    expect(await visible(marta)).toEqual(['projects:p', 'tasks:comun']);
    expect((await as(marta, 'select 1 from profiles where id = $1', [mark.id]))).toHaveLength(0);

    // Marta es la única administradora y ya no hay más cuentas: también puede; su espacio vacío desaparece.
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: exc.inviteCode });
    await expect(rpc(marta, 'delete_my_account')).rejects.toThrow(/única persona administradora/);
    await rpc(marta, 'set_admin', { p_user: ana.id, p_value: true });
    await rpc(marta, 'delete_my_account');
    const members = await as<{ role: string }>(ana, 'select role from space_members where space_id = $1', [exc.id]);
    expect(members).toEqual([{ role: 'admin' }]);
    expect(await visible(ana)).toEqual(['projects:p', 'tasks:comun']);
  });

  it('contraseña provisional: solo administradores, y sirve para entrar', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const [exc] = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { inviteCode: string }[];
    const mark = await newUser('mark@vml.com');
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: exc.inviteCode });
    await expect(rpc(mark, 'admin_set_password', { p_user: marta.id })).rejects.toThrow();
    const password = await rpc(marta, 'admin_set_password', { p_user: mark.id }) as string;
    expect(password).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    await db.query('reset role');
    const ok = await db.query<{ ok: boolean }>('select encrypted_password = extensions.crypt($1, encrypted_password) as ok from auth.users where id = $2', [password, mark.id]);
    expect(ok.rows[0].ok).toBe(true);
  });

  it('sin invitación se entra como usuario normal, sin espacio', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    const me = await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' }) as { isAdmin: boolean; spaces: unknown[] };
    expect(me.isAdmin).toBe(false);
    expect(me.spaces).toHaveLength(0);
    const uri = await newUser('uri@vml.com');
    expect((await rpc(uri, 'register_profile', { p_name: 'Uri', p_code: 'NO-VALE' }) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it('claves de conectores: cada persona solo ve y cambia la suya, y nadie lee la tabla', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });
    await rpc(marta, 'set_my_connector', { p_connector: 'rally', p_secret: 'v1:cifrado', p_info: { rally_user: 'Marta' } });
    expect(await rpc(marta, 'my_connector', { p_connector: 'rally' })).toEqual({ secret: 'v1:cifrado', info: { rally_user: 'Marta' } });
    expect(await rpc(ana, 'my_connector', { p_connector: 'rally' })).toBeNull();
    await expect(as(ana, 'select * from connector_accounts')).rejects.toThrow();
    await rpc(ana, 'delete_my_connector', { p_connector: 'rally' });
    expect(await rpc(marta, 'my_connector', { p_connector: 'rally' })).not.toBeNull();
  });
});
