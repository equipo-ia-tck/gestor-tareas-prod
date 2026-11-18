-- =====================================================================================================
-- Analítica · Rally: herramienta o Rally (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 010.
--
-- Rally no dice desde dónde se hace un cambio. Para saber cuántos cambios de Rally (discusiones, adjuntos, Flow State,
-- Ready, Blocked y altas) salen de la herramienta, la app apunta aquí cada cosa que escribe en Rally:
--   · el tipo (comment, attachment, change, create), la hora y una HUELLA del elemento (16 caracteres del SHA-256 de su ID,
--     p. ej. de «US123»). No se guarda el ID ni ningún texto: solo sirve para cruzarlo con lo que se lee de Rally.
--   · Nadie lee ni escribe la tabla directamente: la app apunta con `log_rally_tool` y solo los administradores leen con
--     `admin_rally_tool`. Se guarda 400 días; si la persona se da de baja, se borra con ella.
-- =====================================================================================================

create table if not exists public.rally_tool_events (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('comment', 'attachment', 'change', 'create')),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{16}$'),
  at timestamptz not null default now()
);
create index if not exists rally_tool_events_at on public.rally_tool_events (at);

alter table public.rally_tool_events enable row level security;
revoke all on public.rally_tool_events from anon, authenticated;

create or replace function public.log_rally_tool(p_kind text, p_hash text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then return; end if;
  if p_kind not in ('comment', 'attachment', 'change', 'create') or coalesce(p_hash, '') !~ '^[0-9a-f]{16}$' then
    raise exception 'Apunte de Rally no válido.';
  end if;
  -- Tope por persona y día, por si algo se dispara en bucle.
  if (select count(*) from rally_tool_events where user_id = auth.uid() and at > now() - interval '1 day') >= 2000 then return; end if;
  insert into rally_tool_events (user_id, kind, artifact_hash) values (auth.uid(), p_kind, p_hash);
  if random() < 0.01 then delete from rally_tool_events where at < now() - interval '400 days'; end if;
end $$;

-- Lo apuntado entre dos instantes (con 10 minutos de margen a cada lado, para cruzar) y desde cuándo se apunta.
create or replace function public.admin_rally_tool(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'since', (select min(at) from rally_tool_events),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'hash', artifact_hash, 'at', at) order by at), '[]')
      from rally_tool_events where at >= p_from - interval '10 minutes' and at < p_to + interval '10 minutes'));
end $$;

revoke execute on function public.log_rally_tool(text, text), public.admin_rally_tool(timestamptz, timestamptz) from public, anon;
grant execute on function public.log_rally_tool(text, text), public.admin_rally_tool(timestamptz, timestamptz) to authenticated;
