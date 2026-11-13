-- =====================================================================================================
-- Claves de los conectores en la nube (nov 2026). Se pega en Supabase → SQL Editor → Run, después de 003.
--
-- Para que Rally funcione desde Vercel sin el servidor del Mac, la clave de API de cada persona se guarda aquí, pero
-- CIFRADA: la cifra y descifra la función de Vercel con un secreto que solo tiene Vercel (RALLY_SECRET). Supabase, el
-- navegador y el repositorio solo ven texto cifrado.
--   · Nadie lee la tabla directamente (RLS sin reglas de lectura).
--   · Cada persona solo puede leer, guardar o borrar la suya, a través de estas funciones y con su sesión.
-- =====================================================================================================

create table if not exists public.connector_accounts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  connector text not null check (connector in ('rally')),
  secret text not null,                  -- clave cifrada (AES-GCM) por la función de Vercel
  info jsonb not null default '{}',      -- datos no secretos: dirección, usuario de Rally…
  updated_at timestamptz not null default now(),
  primary key (user_id, connector)
);

alter table public.connector_accounts enable row level security;
revoke all on public.connector_accounts from anon, authenticated;

create or replace function public.my_connector(p_connector text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('secret', secret, 'info', info)
    from connector_accounts where user_id = auth.uid() and connector = p_connector
$$;

create or replace function public.set_my_connector(p_connector text, p_secret text, p_info jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  insert into connector_accounts (user_id, connector, secret, info, updated_at)
    values (auth.uid(), p_connector, p_secret, coalesce(p_info, '{}'), now())
  on conflict (user_id, connector) do update set secret = excluded.secret, info = excluded.info, updated_at = now();
end $$;

create or replace function public.delete_my_connector(p_connector text) returns void
language sql security definer set search_path = public as $$
  delete from connector_accounts where user_id = auth.uid() and connector = p_connector
$$;

revoke execute on function public.my_connector(text), public.set_my_connector(text, text, jsonb), public.delete_my_connector(text) from public, anon;
grant execute on function public.my_connector(text), public.set_my_connector(text, text, jsonb), public.delete_my_connector(text) to authenticated;
