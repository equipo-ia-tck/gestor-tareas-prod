import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Prueba la base de datos de Supabase (supabase/migrations) en un Postgres de verdad (PGlite), imitando
 * lo mínimo de Supabase: roles anon/authenticated y auth.uid()/auth.email() de la sesión.
 */
const MIGRATION = ['001_equipo.sql', '002_baja_y_contrasenas.sql', '003_alta_sin_invitacion.sql', '004_claves_conectores.sql', '005_calendario_subido.sql', '006_feedback.sql', '007_feedback_formulario.sql', '008_feedback_bloqueado.sql', '009_analitica.sql', '010_analitica_kpis.sql', '011_rally_herramienta.sql', '012_calendario_ics.sql', '013_sharepoint_subido.sql'].map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8')).join('\n');
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
    // 012: el enlace del otro calendario (cifrado) va en la misma tabla; otros conectores no.
    await rpc(marta, 'set_my_connector', { p_connector: 'calendario-ics', p_secret: 'v1:enlace', p_info: { name: 'La Caixa' } });
    expect(await rpc(marta, 'my_connector', { p_connector: 'calendario-ics' })).toEqual({ secret: 'v1:enlace', info: { name: 'La Caixa' } });
    expect(await rpc(ana, 'my_connector', { p_connector: 'calendario-ics' })).toBeNull();
    await expect(rpc(marta, 'set_my_connector', { p_connector: 'otro', p_secret: 'x', p_info: {} })).rejects.toThrow();
  });

  it('calendario subido: con la clave de subida, sin sesión, y cada uno solo ve lo suyo', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const mark = await newUser('mark@vml.com');
    const spaces = await rpc(marta, 'create_space', { p_name: 'Excelencia', p_color: '#f00' }) as { inviteCode: string }[];
    await rpc(mark, 'register_profile', { p_name: 'Mark Ruiz', p_code: spaces[0].inviteCode });

    const token = await rpc(marta, 'create_upload_token') as string;
    expect(token).toMatch(/^gsub_[0-9a-f]{48}$/);
    expect(await rpc(marta, 'upload_token_info')).toMatchObject({ hasToken: true });

    // El proceso del Mac llama sin sesión (anon).
    const upload = async (t: string, data: unknown, kind = 'calendario') => {
      await db.exec("reset role; select set_config('test.uid', '', false); set role anon;");
      return (await db.query<{ r: string }>('select public.upload_connector_file($1, $2, $3, $4) as r', [t, kind, JSON.stringify(data), '2026-11-13T09:00:00Z'])).rows[0].r;
    };
    expect(await upload(token, [{ uid: 'a', title: 'Daily' }])).toBe('Marta García');
    await expect(upload('gsub_mal', [])).rejects.toThrow(/Clave de subida no válida/);
    await expect(upload(token, { no: 'lista' })).rejects.toThrow(/lista/);
    // 013: también las carpetas de SharePoint, en su propia fila; otros tipos, no.
    await upload(token, [{ site: 'https://caixa.sharepoint.com/sites/E', root: 'Docs/General', items: [] }], 'sharepoint');
    await expect(upload(token, [], 'otro')).rejects.toThrow(/no admitido/);
    expect((await as<{ kind: string }>(marta, 'select kind from connector_uploads order by kind')).map((r) => r.kind)).toEqual(['calendario', 'sharepoint']);
    await db.exec("reset role; delete from connector_uploads where kind = 'sharepoint';");
    await db.exec('reset role; set role anon;');
    await expect(db.query('select * from connector_uploads')).rejects.toThrow();

    const own = await as<{ data: { title: string }[] }>(marta, 'select data from connector_uploads');
    expect(own[0].data[0].title).toBe('Daily');
    expect(await as(mark, 'select * from connector_uploads')).toEqual([]);
    await expect(as(marta, "insert into connector_uploads (owner, kind, data) values ($1, 'calendario', '[]')", [marta.id])).rejects.toThrow();
    await expect(as(marta, 'select * from upload_tokens')).rejects.toThrow(/permission denied/);

    // Una clave nueva invalida la anterior; quitarla borra lo subido.
    const second = await rpc(marta, 'create_upload_token') as string;
    await expect(upload(token, [])).rejects.toThrow(/no válida/);
    await upload(second, []);
    await rpc(marta, 'revoke_upload_token');
    await expect(upload(second, [])).rejects.toThrow(/no válida/);
    expect(await as(marta, 'select * from connector_uploads')).toEqual([]);
  });

  it('feedback: lo envía cualquiera, solo lo leen y gestionan los administradores', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });

    await rpc(ana, 'send_feedback', { p_kind: 'bug', p_body: '  El tablero no carga  ', p_page: '#/board', p_user_agent: 'Chrome' });
    await expect(rpc(ana, 'send_feedback', { p_kind: 'bug', p_body: '   ', p_page: '', p_user_agent: '' })).rejects.toThrow(/Escribe/);
    await expect(rpc(ana, 'send_feedback', { p_kind: 'otra', p_body: 'x', p_page: '', p_user_agent: '' })).rejects.toThrow();
    await expect(rpc(ana, 'admin_feedback')).rejects.toThrow(/administra/);
    await expect(as(ana, 'select * from feedback')).rejects.toThrow();

    const list = await rpc(marta, 'admin_feedback') as { id: string; body: string; authorName: string; kind: string; page: string; status: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ body: 'El tablero no carga', authorName: 'Ana', kind: 'bug', page: '#/board', status: 'new' });

    await expect(rpc(ana, 'admin_update_feedback', { p_id: list[0].id, p_status: 'done', p_task_id: null })).rejects.toThrow(/administra/);
    expect(await rpc(marta, 'admin_update_feedback', { p_id: list[0].id, p_status: null, p_task_id: 't1' })).toMatchObject({ status: 'new', taskId: 't1' });
    expect(await rpc(marta, 'admin_update_feedback', { p_id: list[0].id, p_status: 'doing', p_task_id: null })).toMatchObject({ status: 'doing', taskId: 't1' });
    // Bloqueado (migración 008), para la columna del tablero.
    expect(await rpc(marta, 'admin_update_feedback', { p_id: list[0].id, p_status: 'blocked', p_task_id: null })).toMatchObject({ status: 'blocked' });
    await expect(rpc(marta, 'admin_update_feedback', { p_id: list[0].id, p_status: 'raro', p_task_id: null })).rejects.toThrow();
  });

  it('feedback con formulario: frase y parte obligatorias, impacto solo si algo no funciona', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });
    const send = (args: Record<string, unknown>) => rpc(ana, 'send_feedback_form', {
      p_kind: 'bug', p_area: 'board', p_title: 'No carga', p_body: '', p_impact: 'blocking', p_page: '#/board', p_screen: '1440×900', p_user_agent: 'Chrome', ...args,
    });
    await send({});
    await send({ p_kind: 'idea', p_area: 'notes', p_title: ' Plantillas de acta ', p_body: 'Con asistentes', p_impact: 'blocking' });
    await expect(send({ p_title: '  ' })).rejects.toThrow(/una frase/);
    await expect(send({ p_area: '' })).rejects.toThrow(/parte de la web/);
    await expect(send({ p_kind: 'raro' })).rejects.toThrow();
    await expect(send({ p_impact: 'muchisimo' })).rejects.toThrow();
    const list = await rpc(marta, 'admin_feedback') as Record<string, unknown>[];
    expect(list.map((f) => [f.kind, f.area, f.title, f.body, f.impact, f.screen])).toEqual([
      ['idea', 'notes', 'Plantillas de acta', 'Con asistentes', null, '1440×900'],
      ['bug', 'board', 'No carga', '', 'blocking', '1440×900'],
    ]);
    // Lo enviado con la versión anterior se sigue leyendo.
    await rpc(ana, 'send_feedback', { p_kind: 'other', p_body: 'Antiguo', p_page: '', p_user_agent: '' });
    expect((await rpc(marta, 'admin_feedback') as Record<string, unknown>[])[0]).toMatchObject({ kind: 'other', title: '', body: 'Antiguo' });
  });

  it('analítica: cada uno apunta lo suyo, solo los administradores lo leen y sin textos en la pantalla', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });

    await rpc(ana, 'log_usage', { p_kind: 'session', p_screen: 'board' });
    await rpc(ana, 'log_usage', { p_kind: 'screen', p_screen: 'board' });
    await rpc(ana, 'log_usage', { p_kind: 'screen', p_screen: 'board' });
    await rpc(ana, 'log_usage', { p_kind: 'screen', p_screen: 'rally' });
    await expect(rpc(ana, 'log_usage', { p_kind: 'screen', p_screen: 'project/Mi proyecto secreto' })).rejects.toThrow(/Pantalla/);
    await expect(rpc(ana, 'log_usage', { p_kind: 'clic', p_screen: '' })).rejects.toThrow();
    await expect(as(ana, 'select * from usage_events')).rejects.toThrow();
    await expect(rpc(ana, 'admin_usage', { p_from: '2000-01-01', p_to: '2100-01-01' })).rejects.toThrow(/administra/);

    const r = await rpc(marta, 'admin_usage', { p_from: '2000-01-01', p_to: '2100-01-01' }) as { users: { name: string }[]; rows: { user: string; kind: string; screen: string; count: number }[] };
    expect(r.users.map((u) => u.name)).toEqual(['Ana', 'Marta García']);
    const counts = Object.fromEntries(r.rows.map((x) => [`${x.kind}:${x.screen}`, x.count]));
    expect(counts).toEqual({ 'session:': 1, 'screen:board': 2, 'screen:rally': 1 });
    expect(r.rows.every((x) => x.user === ana.id)).toBe(true);
    expect((await rpc(marta, 'admin_usage', { p_from: '2000-01-01', p_to: '2000-01-02' }) as { rows: unknown[] }).rows).toEqual([]);
  });

  it('Rally desde la herramienta: se apunta con huella, solo lo leen los administradores', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });

    await rpc(ana, 'log_rally_tool', { p_kind: 'change', p_hash: '0123456789abcdef' });
    await rpc(ana, 'log_rally_tool', { p_kind: 'comment', p_hash: '0123456789abcdef' });
    await expect(rpc(ana, 'log_rally_tool', { p_kind: 'change', p_hash: 'US123' })).rejects.toThrow(/no válido/);
    await expect(rpc(ana, 'log_rally_tool', { p_kind: 'borrar', p_hash: '0123456789abcdef' })).rejects.toThrow(/no válido/);
    await expect(as(ana, 'select * from rally_tool_events')).rejects.toThrow();
    await expect(rpc(ana, 'admin_rally_tool', { p_from: '2000-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z' })).rejects.toThrow(/administra/);

    const r = await rpc(marta, 'admin_rally_tool', { p_from: '2000-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z' }) as { since: string | null; rows: { kind: string; hash: string }[] };
    expect(r.since).not.toBeNull();
    expect(r.rows.map((x) => x.kind).sort()).toEqual(['change', 'comment']);
    expect(r.rows.every((x) => x.hash === '0123456789abcdef')).toBe(true);
    expect((await rpc(marta, 'admin_rally_tool', { p_from: '2000-01-01T00:00:00Z', p_to: '2000-01-02T00:00:00Z' }) as { rows: unknown[] }).rows).toEqual([]);
  });

  it('analítica con KPIs: acciones y preferencias sin textos, y foto de los datos con recuentos', async () => {
    const marta = await newUser('marta@vml.com');
    await rpc(marta, 'register_profile', { p_name: 'Marta García', p_code: '' });
    const ana = await newUser('ana@vml.com');
    await rpc(ana, 'register_profile', { p_name: 'Ana', p_code: '' });

    await rpc(ana, 'log_usage', { p_kind: 'screen', p_screen: 'board' }); // como la versión anterior (dos parámetros)
    await rpc(ana, 'log_usage', { p_kind: 'visit', p_screen: 'board', p_name: '', p_detail: '', p_value: 40 });
    await rpc(ana, 'log_usage', { p_kind: 'quality', p_screen: 'board', p_name: '', p_detail: '', p_value: null });
    await rpc(ana, 'log_usage', { p_kind: 'action', p_screen: 'rally', p_name: 'rally-add', p_detail: 'all.project', p_value: 5 });
    await rpc(ana, 'log_usage', { p_kind: 'state', p_screen: 'calendar', p_name: 'calendar-tasks', p_detail: '', p_value: 0 });
    await rpc(ana, 'log_usage', { p_kind: 'state', p_screen: 'calendar', p_name: 'calendar-tasks', p_detail: '', p_value: 1 });
    await expect(rpc(ana, 'log_usage', { p_kind: 'action', p_screen: 'rally', p_name: 'Un Título', p_detail: '', p_value: 1 })).rejects.toThrow();
    await expect(rpc(ana, 'log_usage', { p_kind: 'action', p_screen: 'rally', p_name: 'x', p_detail: 'texto con espacios', p_value: 1 })).rejects.toThrow();

    const now = new Date().toISOString();
    await push(ana, [
      { tbl: 'tasks', key: 't1', data: task('t1', { status: 'todo', due_date: '2026-11-20', project_id: 'p1', external_id: 'US-123', created_at: now }) },
      { tbl: 'tasks', key: 't2', data: task('t2', { status: 'done', created_at: now }) },
      { tbl: 'projects', key: 'p1', data: { id: 'p1', name: 'Sección', parent_id: null, created_at: now } },
      { tbl: 'notes', key: 'n1', data: { id: 'n1', title: 'Acta', body: '- [x] Hacerlo [[t:t2]]', project_id: 'p1', people: [], created_at: now, deleted_at: null } },
    ]);

    const r = await rpc(marta, 'admin_usage', { p_from: '2000-01-01', p_to: '2100-01-01' }) as {
      users: { name: string; snapshot: Record<string, unknown> }[]; rows: { kind: string; name: string; detail: string; count: number; value: number | null }[];
      states: { name: string; value: number }[];
    };
    const snap = r.users.find((u) => u.name === 'Ana')!.snapshot;
    expect(snap).toMatchObject({ tasksCreated: 2, createdWithDate: 1, tasksActive: 1, activeWithDate: 1, activeWithProject: 1, rallyActive: 1,
      notesCreated: 1, notesInSection: 1, sections: 1, tasksFromNotes: 1, tasksFromNotesDone: 1, rallyConnected: false });
    expect(r.rows.find((x) => x.kind === 'visit')?.value).toBe(40);
    expect(r.rows.find((x) => x.kind === 'action')).toMatchObject({ name: 'rally-add', detail: 'all.project', count: 1, value: 5 });
    expect(r.states).toEqual([expect.objectContaining({ name: 'calendar-tasks', value: 1 })]);
  });
});
