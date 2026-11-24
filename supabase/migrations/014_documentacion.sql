-- =====================================================================================================
-- Documentación del equipo desde Confluence (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de
-- 001 a 013.
--
-- El equipo descarga una vez al mes el export HTML de los espacios de Confluence (aprobado por José y Mati: solo cómo
-- trabaja el equipo y para qué sirve cada cosa, sin documentación privada del cliente). La sube UNA sola persona (una
-- administradora), no desde la app sino con un script del Mac (`scripts/subir-docs.ts`), igual que el calendario: el
-- script no usa contraseña ni la clave service_role, solo una «clave de subida» que se genera una vez en Ajustes →
-- Documentación. El conector MCP la busca con la sesión de cada persona (`buscar_en_documentacion`) y cita el enlace a
-- Confluence.
--
-- · La tabla `docs` es común del equipo: cualquier miembro activo la lee (RLS); nadie la escribe directamente.
-- · `docs_token` guarda la huella (sha256) de la clave de subida; la clave se ve una vez. Es una sola para el equipo
--   (la última generada manda). La escribe `upload_docs`, que llama el script sin sesión (rol anon) solo con la clave,
--   y que exige que quien generó la clave siga siendo administradora activa.
-- =====================================================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.docs (
  id text primary key,                        -- id de la página en Confluence
  space text not null default '',
  title text not null default '',
  path text not null default '',              -- migas: Espacio › … › Página
  url text not null default '',               -- enlace a la página en Confluence
  body text not null default '',              -- texto de la página, sin HTML
  updated_at timestamptz not null default now()
);

-- Una sola clave de subida para el equipo (fila única: id siempre true).
create table if not exists public.docs_token (
  id boolean primary key default true check (id),
  token_hash text not null,
  owner uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.docs enable row level security;
alter table public.docs_token enable row level security;
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated using (public.me_active());
revoke all on public.docs, public.docs_token from anon, authenticated;
grant select on public.docs to authenticated;

create or replace function public.docs_token_hash(p_token text) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.digest(convert_to(trim(p_token), 'UTF8'), 'sha256'), 'hex')
$$;

/** Cuántas páginas hay y cuándo se subieron por última vez (para Ajustes y para informar). */
create or replace function public.docs_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when me_active()
    then jsonb_build_object('count', count(*), 'updatedAt', max(updated_at))
    else jsonb_build_object('count', 0, 'updatedAt', null) end
  from public.docs
$$;

/** ¿Hay clave de subida, desde cuándo y de quién? Solo administradores. */
create or replace function public.docs_token_info() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return (select coalesce(jsonb_build_object('hasToken', true, 'createdAt', t.created_at, 'owner', p.name),
                          jsonb_build_object('hasToken', false))
            from docs_token t left join profiles p on p.id = t.owner limit 1);
end $$;

/** Nueva clave de subida (la anterior deja de valer). Se devuelve una sola vez. Solo administradores. */
create or replace function public.create_docs_token() returns text
language plpgsql security definer set search_path = public as $$
declare v_token text := 'dsub_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform require_admin();
  insert into docs_token (id, token_hash, owner, created_at) values (true, docs_token_hash(v_token), auth.uid(), now())
    on conflict (id) do update set token_hash = excluded.token_hash, owner = excluded.owner, created_at = now();
  return v_token;
end $$;

/** Quita la clave de subida (no borra la documentación). Solo administradores. */
create or replace function public.revoke_docs_token() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  delete from docs_token;
end $$;

/**
 * La llama el script del Mac sin sesión (rol anon), solo con la clave. Sube un lote de páginas; el primer lote de la
 * subida mensual va con `p_reset = true` (vacía lo anterior). Exige que quien generó la clave siga siendo administradora
 * activa. Devuelve cuántas páginas hay en total tras el lote.
 */
create or replace function public.upload_docs(p_token text, p_docs jsonb, p_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ok boolean; n int;
begin
  select (p.is_admin and not p.disabled) into v_ok
    from docs_token t join profiles p on p.id = t.owner
   where t.token_hash = docs_token_hash(coalesce(p_token, ''));
  if v_ok is not true then raise exception 'Clave de subida no válida: genera otra en Ajustes → Documentación.' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_docs, '[]'::jsonb)) is distinct from 'array' then raise exception 'Se esperaba una lista de páginas.'; end if;
  if pg_column_size(p_docs) > 6 * 1024 * 1024 then raise exception 'El lote es demasiado grande; súbelo en trozos más pequeños.'; end if;
  if p_reset then delete from public.docs where id is not null; end if; -- WHERE explícito: Supabase prohíbe DELETE sin él
  insert into public.docs (id, space, title, path, url, body, updated_at)
  select coalesce(nullif(d->>'id', ''), gen_random_uuid()::text),
         coalesce(d->>'space', ''), coalesce(d->>'title', ''), coalesce(d->>'path', ''),
         coalesce(d->>'url', ''), coalesce(d->>'body', ''), now()
  from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) d
  on conflict (id) do update set
    space = excluded.space, title = excluded.title, path = excluded.path,
    url = excluded.url, body = excluded.body, updated_at = now();
  select count(*) into n from public.docs;
  return jsonb_build_object('count', n);
end $$;

revoke execute on function public.docs_token_hash(text), public.docs_info(), public.docs_token_info(),
  public.create_docs_token(), public.revoke_docs_token(), public.upload_docs(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.docs_info(), public.docs_token_info(), public.create_docs_token(), public.revoke_docs_token() to authenticated;
grant execute on function public.upload_docs(text, jsonb, boolean) to anon, authenticated;
