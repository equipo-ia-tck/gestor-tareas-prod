-- =====================================================================================================
-- Documentación del equipo desde Confluence (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de
-- 001 a 013.
--
-- El equipo descarga una vez al mes el export HTML de los espacios de Confluence (aprobado por José y Mati: solo cómo
-- trabaja el equipo y para qué sirve cada cosa, sin documentación privada del cliente). Un administrador lo sube en
-- Ajustes → Documentación; el navegador lee el HTML, saca el texto de cada página y lo guarda aquí. El conector MCP la
-- busca con la sesión de cada persona (herramienta `buscar_en_documentacion`) y cita el enlace a la página de Confluence.
--
-- Es documentación común del equipo: cualquier miembro activo la lee; solo los administradores la suben (igual que
-- `item_types` y `labels`). Nadie escribe directamente en la tabla: solo a través de `admin_save_docs`.
-- =====================================================================================================

create table if not exists public.docs (
  id text primary key,                        -- id de la página en Confluence
  space text not null default '',
  title text not null default '',
  path text not null default '',              -- migas: Espacio › … › Página
  url text not null default '',               -- enlace a la página en Confluence
  body text not null default '',              -- texto de la página, sin HTML
  updated_at timestamptz not null default now()
);

alter table public.docs enable row level security;
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated using (public.me_active());
revoke insert, update, delete, truncate on public.docs from anon, authenticated;

/**
 * Sube un lote de páginas. La subida mensual manda el primer lote con `p_reset = true` (vacía lo anterior) y el resto con
 * `false`. Devuelve cuántas páginas hay en total tras el lote. Solo administradores.
 */
create or replace function public.admin_save_docs(p_docs jsonb, p_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform require_admin();
  if p_reset then delete from public.docs; end if;
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

/** Cuántas páginas hay y cuándo se subieron por última vez (para Ajustes → Documentación). */
create or replace function public.docs_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when me_active()
    then jsonb_build_object('count', count(*), 'updatedAt', max(updated_at))
    else jsonb_build_object('count', 0, 'updatedAt', null) end
  from public.docs
$$;

revoke execute on function public.admin_save_docs(jsonb, boolean), public.docs_info() from public, anon;
grant execute on function public.admin_save_docs(jsonb, boolean), public.docs_info() to authenticated;
