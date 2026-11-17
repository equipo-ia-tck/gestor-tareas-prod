-- =====================================================================================================
-- Analítica de uso (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 008.
--
-- La app apunta sola, por persona y día (hora de Madrid), cada entrada en la app y cada pantalla que abre. Solo los
-- administradores lo ven (Más → Analítica).
--   · No se guarda contenido: ni títulos, ni notas, ni a quién se abre. Solo el nombre de la pantalla («board», «rally»…).
--   · Nadie lee ni escribe la tabla directamente (RLS sin reglas): todo va por las funciones de abajo.
--   · Si la persona se da de baja, sus eventos se borran con ella. Se guardan 400 días.
-- =====================================================================================================

create table if not exists public.usage_events (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('session', 'screen')),
  screen text not null default '' check (length(screen) <= 40),
  day date not null default ((now() at time zone 'Europe/Madrid')::date),
  at timestamptz not null default now()
);
create index if not exists usage_events_day on public.usage_events (day, user_id);

alter table public.usage_events enable row level security;
revoke all on public.usage_events from anon, authenticated;

-- Lo llama la app. Pantalla: letras, números y guiones (nunca un id ni un texto escrito por la persona).
create or replace function public.log_usage(p_kind text, p_screen text) returns void
language plpgsql security definer set search_path = public as $$
declare v_screen text := coalesce(p_screen, '');
begin
  if auth.uid() is null or not me_active() then return; end if;
  if p_kind not in ('session', 'screen') then raise exception 'Evento de uso desconocido.'; end if;
  if v_screen !~ '^[a-z0-9-]{0,40}$' then raise exception 'Pantalla no válida.'; end if;
  -- Tope por persona y día, por si algo se dispara en bucle.
  if (select count(*) from usage_events where user_id = auth.uid() and day = (now() at time zone 'Europe/Madrid')::date) >= 3000 then return; end if;
  insert into usage_events (user_id, kind, screen) values (auth.uid(), p_kind, case when p_kind = 'session' then '' else v_screen end);
  -- Limpieza de lo antiguo, de vez en cuando.
  if random() < 0.01 then delete from usage_events where day < (now() at time zone 'Europe/Madrid')::date - 400; end if;
end $$;

-- Para el panel: todas las cuentas y los recuentos por persona, día, tipo y pantalla entre dos días (incluidos).
create or replace function public.admin_usage(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'login', p.login, 'disabled', p.disabled) order by p.name), '[]') from profiles p),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('user', r.user_id, 'day', r.day, 'kind', r.kind, 'screen', r.screen, 'count', r.n, 'last', r.last)), '[]')
      from (select user_id, day, kind, screen, count(*) as n, max(at) as last from usage_events
              where day between p_from and p_to group by user_id, day, kind, screen) r));
end $$;

revoke execute on function public.log_usage(text, text), public.admin_usage(date, date) from public, anon;
grant execute on function public.log_usage(text, text), public.admin_usage(date, date) to authenticated;
