-- =====================================================================================================
-- Pantallas de cada cuenta (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 012.
--
-- Los administradores eligen en Ajustes → Pantallas qué pantallas ve cada persona en la app (Tablero, Rally, Lista,
-- Asistente…). Es para simplificar la app a cada uno: oculta la pantalla y su entrada en la barra lateral, pero no cambia
-- qué datos puede ver nadie (eso lo siguen decidiendo las reglas de siempre).
--   · `profiles.hidden_screens`: pantallas ocultas de esa cuenta; null = las del equipo por defecto.
--   · `app_settings` 'default_hidden_screens': las ocultas por defecto (cuentas nuevas y las que no se han tocado).
--   · `me()` devuelve `hiddenScreens` (ya resuelto); `admin_users()` y `admin_overview()`, lo de cada cuenta y el defecto.
-- =====================================================================================================

alter table public.profiles add column if not exists hidden_screens text[];

/** Las pantallas ocultas de una cuenta: las suyas o, si no tiene, las del equipo por defecto. */
create or replace function public.screens_of(p_hidden text[]) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(p_hidden,
    (select coalesce(array_remove(string_to_array(v, ','), ''), '{}') from app_settings where k = 'default_hidden_screens'),
    '{}')
$$;

/** Lista de pantallas válida: claves cortas `[a-z-]`, sin repetir, como mucho 40. */
create or replace function public.clean_screens(p text[]) returns text[]
language plpgsql immutable as $$
declare out text[] := '{}'; s text;
begin
  if p is null then return null; end if;
  foreach s in array p loop
    if s !~ '^[a-z][a-z-]{0,29}$' then raise exception 'Pantalla no válida: %', s; end if;
    if not s = any(out) then out := out || s; end if;
  end loop;
  if array_length(out, 1) > 40 then raise exception 'Demasiadas pantallas.'; end if;
  return out;
end $$;

-- Todo lo que la app necesita saber de la sesión de una vez (igual que en 001, más `hiddenScreens`).
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p.id is null then null else jsonb_build_object(
    'user', jsonb_build_object('id', p.id, 'login', p.login, 'name', p.name),
    'disabled', p.disabled,
    'isAdmin', p.is_admin and not p.disabled,
    'accessVersion', p.access_version,
    'team', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'login', u.login, 'name', u.name) order by u.name), '[]') from profiles u where not u.disabled),
    'spaces', spaces_json(true),
    'adminCode', case when p.is_admin and not p.disabled then (select v from app_settings where k = 'admin_code') end,
    'hiddenScreens', to_jsonb(screens_of(p.hidden_screens))
  ) end
  from (select 1) one left join profiles p on p.id = auth.uid()
$$;

create or replace function public.admin_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'login', p.login, 'name', p.name, 'isAdmin', p.is_admin, 'disabled', p.disabled, 'createdAt', p.created_at,
    'spaces', (select coalesce(jsonb_agg(m.space_id), '[]') from space_members m where m.user_id = p.id),
    -- null = usa las del equipo por defecto.
    'hiddenScreens', to_jsonb(p.hidden_screens)
  ) order by p.name), '[]') from profiles p);
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object('users', admin_users(), 'spaces', spaces_json(false),
    'adminCode', (select v from app_settings where k = 'admin_code'),
    'defaultHiddenScreens', to_jsonb(screens_of(null)));
end $$;

/** Pantallas ocultas de varias cuentas a la vez (null = volver a las del equipo por defecto). */
create or replace function public.admin_set_screens(p_users uuid[], p_hidden text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update profiles set hidden_screens = clean_screens(p_hidden) where id = any(p_users);
  return admin_users();
end $$;

/** Pantallas ocultas por defecto (las cuentas nuevas y las que no tienen las suyas). */
create or replace function public.admin_set_default_screens(p_hidden text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  insert into app_settings (k, v) values ('default_hidden_screens', array_to_string(coalesce(clean_screens(p_hidden), '{}'), ','))
    on conflict (k) do update set v = excluded.v;
  return to_jsonb(screens_of(null));
end $$;

revoke execute on function public.screens_of(text[]), public.clean_screens(text[]),
  public.admin_set_screens(uuid[], text[]), public.admin_set_default_screens(text[]) from public, anon;
grant execute on function public.admin_set_screens(uuid[], text[]), public.admin_set_default_screens(text[]) to authenticated;
