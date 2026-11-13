-- =====================================================================================================
-- Calendario subido desde el Mac. Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 004.
--
-- Un flujo de Power Automate escribe OneDrive/Gestor/calendario.json y OneDrive lo baja al Mac. La app en Vercel no ve
-- esa carpeta, así que un pequeño proceso del Mac (scripts/subir-onedrive.ts) sube las reuniones aquí y la app las lee.
--
-- · El proceso no usa la contraseña: usa una «clave de subida» que la persona genera en Ajustes → Calendario de Outlook. Aquí solo
--   se guarda su huella (sha256); la clave se ve una vez. Generar otra invalida la anterior; «Quitar» la borra.
-- · Cada persona solo lee lo suyo (RLS). Nadie escribe en las tablas directamente: solo con las funciones de abajo.
-- · Darse de baja lo borra en cascada (va colgado del perfil).
-- =====================================================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.connector_uploads (
  owner uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('calendario')),
  data jsonb not null,
  -- Cuándo escribió el flujo el archivo (su fecha de modificación) y cuándo llegó aquí.
  file_at timestamptz,
  uploaded_at timestamptz not null default now(),
  primary key (owner, kind)
);

create table if not exists public.upload_tokens (
  owner uuid primary key references public.profiles (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.connector_uploads enable row level security;
alter table public.upload_tokens enable row level security;

drop policy if exists uploads_select on public.connector_uploads;
create policy uploads_select on public.connector_uploads for select to authenticated using (owner = auth.uid() and public.me_active());

revoke all on public.connector_uploads, public.upload_tokens from anon, authenticated;
grant select on public.connector_uploads to authenticated;

create or replace function public.upload_token_hash(p_token text) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.digest(convert_to(trim(p_token), 'UTF8'), 'sha256'), 'hex')
$$;

/** Nueva clave de subida (la anterior deja de valer). Se devuelve una sola vez. */
create or replace function public.create_upload_token() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_token text := 'gsub_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  insert into upload_tokens (owner, token_hash) values (auth.uid(), upload_token_hash(v_token))
    on conflict (owner) do update set token_hash = excluded.token_hash, created_at = now();
  return v_token;
end $$;

/** Quita la clave de subida y lo subido. */
create or replace function public.revoke_upload_token() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  delete from upload_tokens where owner = auth.uid();
  delete from connector_uploads where owner = auth.uid();
end $$;

/** ¿Tiene clave y desde cuándo? (lo subido se lee de la tabla). */
create or replace function public.upload_token_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('hasToken', exists (select 1 from upload_tokens where owner = auth.uid()),
                            'createdAt', (select created_at from upload_tokens where owner = auth.uid()))
$$;

/**
 * La llama el proceso del Mac sin sesión (rol anon), solo con la clave. Guarda la lista de reuniones ya recortada
 * (`trimOutlookEvents`) y la fecha del archivo. Devuelve el nombre de la cuenta, para que el proceso diga a quién sube.
 */
create or replace function public.upload_connector_file(p_token text, p_kind text, p_data jsonb, p_file_at timestamptz) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_name text;
begin
  select t.owner, p.name into v_owner, v_name
    from upload_tokens t join profiles p on p.id = t.owner
   where t.token_hash = upload_token_hash(coalesce(p_token, '')) and not p.disabled;
  if v_owner is null then raise exception 'Clave de subida no válida: genera otra en Ajustes → Calendario de Outlook.' using errcode = '42501'; end if;
  if p_kind is distinct from 'calendario' then raise exception 'Tipo de archivo no admitido.'; end if;
  if jsonb_typeof(p_data) is distinct from 'array' then raise exception 'Se esperaba la lista de reuniones.'; end if;
  if pg_column_size(p_data) > 5 * 1024 * 1024 then raise exception 'El calendario es demasiado grande.'; end if;
  insert into connector_uploads (owner, kind, data, file_at, uploaded_at) values (v_owner, p_kind, p_data, p_file_at, now())
    on conflict (owner, kind) do update set data = excluded.data, file_at = excluded.file_at, uploaded_at = now();
  return v_name;
end $$;

revoke execute on function public.upload_token_hash(text), public.create_upload_token(), public.revoke_upload_token(),
  public.upload_token_info(), public.upload_connector_file(text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.create_upload_token(), public.revoke_upload_token(), public.upload_token_info() to authenticated;
grant execute on function public.upload_connector_file(text, text, jsonb, timestamptz) to anon, authenticated;
