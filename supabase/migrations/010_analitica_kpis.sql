-- =====================================================================================================
-- Analítica: KPIs por pantalla (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 009.
--
-- Amplía `usage_events` para los KPIs de Más → Analítica (por persona y de todo el equipo):
--   · `visit`   = segundos a la vista en una pantalla (value), para el tiempo medio.
--   · `quality` = visita «de calidad»: 15 s a la vista o alguna acción en ella (una por visita).
--   · `action`  = algo que se hace (name: «task-create», «rally-comment»…; detail: de dónde o cómo, p. ej. «dblclick»).
--   · `state`   = una preferencia de la persona (p. ej. «calendar-tasks» = 1/0); cuenta la última.
-- Siguen sin guardarse textos: name y detail solo admiten letras minúsculas, números y . , : _ -
--
-- `admin_usage` devuelve además, por persona, una foto de sus datos calculada aquí mismo con recuentos (nunca
-- títulos): tareas creadas y con fecha o proyecto, tareas de Rally, notas y secciones, tareas salidas de notas,
-- grupos, fichas de personas rellenas y si tiene Rally conectado.
-- =====================================================================================================

alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check
  check (kind in ('session', 'screen', 'visit', 'quality', 'action', 'state'));
alter table public.usage_events add column if not exists name text not null default '';
alter table public.usage_events add column if not exists detail text not null default '';
alter table public.usage_events add column if not exists value integer;
alter table public.usage_events drop constraint if exists usage_events_name_check;
alter table public.usage_events add constraint usage_events_name_check check (name ~ '^[a-z0-9-]{0,40}$');
alter table public.usage_events drop constraint if exists usage_events_detail_check;
alter table public.usage_events add constraint usage_events_detail_check check (length(detail) <= 200 and detail ~ '^[a-z0-9_.,:-]*$');

-- La versión de 009 tenía dos parámetros; esta los mantiene (con valores por defecto) para las pestañas ya abiertas.
drop function if exists public.log_usage(text, text);
create or replace function public.log_usage(p_kind text, p_screen text, p_name text default '', p_detail text default '', p_value integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_screen text := coalesce(p_screen, '');
  v_name text := coalesce(p_name, '');
  v_detail text := coalesce(p_detail, '');
begin
  if auth.uid() is null or not me_active() then return; end if;
  if p_kind not in ('session', 'screen', 'visit', 'quality', 'action', 'state') then raise exception 'Evento de uso desconocido.'; end if;
  if v_screen !~ '^[a-z0-9-]{0,40}$' then raise exception 'Pantalla no válida.'; end if;
  if v_name !~ '^[a-z0-9-]{0,40}$' or v_detail !~ '^[a-z0-9_.,:-]{0,200}$' then raise exception 'Evento de uso no válido.'; end if;
  if (select count(*) from usage_events where user_id = auth.uid() and day = (now() at time zone 'Europe/Madrid')::date) >= 5000 then return; end if;
  insert into usage_events (user_id, kind, screen, name, detail, value)
    values (auth.uid(), p_kind, case when p_kind = 'session' then '' else v_screen end, v_name, v_detail,
            case when p_value is null then null else least(greatest(p_value, -1000000), 1000000) end);
  if random() < 0.01 then delete from usage_events where day < (now() at time zone 'Europe/Madrid')::date - 400; end if;
end $$;

-- Foto de los datos de una persona: solo recuentos. Las fechas de creación se comparan con el periodo.
create or replace function public.usage_snapshot(p_user uuid, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  with
  tasks as (
    select data from records where tbl = 'tasks' and owner = p_user and data is not null and data ->> 'deleted_at' is null
  ),
  notes as (
    select data from records where tbl = 'notes' and owner = p_user and data is not null and data ->> 'deleted_at' is null
  ),
  linked as (  -- tareas enlazadas desde las notas de la persona ([[t:<id>]])
    select distinct m[1] as id from notes, regexp_matches(coalesce(notes.data ->> 'body', ''), '\[\[t:([^\]]+)\]\]', 'g') as m
  ),
  people as (
    select data from records where tbl = 'people' and scope = p_user::text and data is not null
  ),
  settings as (
    select data from records where tbl = 'settings' and scope = p_user::text and data is not null limit 1
  ),
  period as (select p_from::timestamptz as a, (p_to + 1)::timestamptz as b)
  select jsonb_build_object(
    'tasksCreated', (select count(*) from tasks, period where (data ->> 'created_at')::timestamptz >= a and (data ->> 'created_at')::timestamptz < b),
    'createdWithDate', (select count(*) from tasks, period where (data ->> 'created_at')::timestamptz >= a and (data ->> 'created_at')::timestamptz < b and data ->> 'due_date' is not null),
    'createdWithProject', (select count(*) from tasks, period where (data ->> 'created_at')::timestamptz >= a and (data ->> 'created_at')::timestamptz < b and data ->> 'project_id' is not null),
    'tasksActive', (select count(*) from tasks where data ->> 'status' = 'todo'),
    'activeWithDate', (select count(*) from tasks where data ->> 'status' = 'todo' and data ->> 'due_date' is not null),
    'activeWithProject', (select count(*) from tasks where data ->> 'status' = 'todo' and data ->> 'project_id' is not null),
    'rallyActive', (select count(*) from tasks where data ->> 'status' = 'todo' and coalesce(data ->> 'external_id', '') ~ '^(US|TS|DE|DS|TA|TC|FE?)-?[0-9]+$'),
    'notesCreated', (select count(*) from notes, period where (data ->> 'created_at')::timestamptz >= a and (data ->> 'created_at')::timestamptz < b),
    'notesTotal', (select count(*) from notes),
    'notesInSection', (select count(*) from notes where data ->> 'project_id' is not null),
    'sections', (select count(*) from records where tbl = 'projects' and owner = p_user and data is not null),
    'projectsCreated', (select count(*) from records, period where tbl = 'projects' and owner = p_user and data is not null
                          and (data ->> 'created_at')::timestamptz >= a and (data ->> 'created_at')::timestamptz < b),
    'tasksFromNotes', (select count(*) from tasks where data ->> 'id' in (select id from linked)),
    'tasksFromNotesDone', (select count(*) from tasks where data ->> 'id' in (select id from linked) and data ->> 'status' = 'done'),
    'groups', coalesce((select jsonb_array_length(coalesce(data -> 'groups', '[]')) from settings), 0),
    'peopleCards', (select count(*) from people),
    'peopleInGroup', (select count(*) from people where coalesce(data ->> 'group_id', '') <> ''),
    'peopleWithEmail', (select count(*) from people where coalesce(data ->> 'email', '') <> ''),
    'peopleWithRole', (select count(*) from people where coalesce(data ->> 'role', '') <> ''),
    'rallyConnected', exists (select 1 from connector_accounts where user_id = p_user and connector = 'rally'),
    'lastReviewOn', (select data -> 'ui' ->> 'last_review_on' from settings)
  )
$$;

create or replace function public.admin_usage(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return jsonb_build_object(
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'login', p.login, 'disabled', p.disabled,
                'snapshot', usage_snapshot(p.id, p_from, p_to)) order by p.name), '[]') from profiles p),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('user', r.user_id, 'day', r.day, 'kind', r.kind, 'screen', r.screen,
                'name', r.name, 'detail', r.detail, 'count', r.n, 'value', r.v, 'last', r.last)), '[]')
      from (select user_id, day, kind, screen, name, detail, count(*) as n, sum(value) as v, max(at) as last from usage_events
              where day between p_from and p_to and kind <> 'state' group by user_id, day, kind, screen, name, detail) r),
    -- La última preferencia de cada persona (aunque sea de antes del periodo).
    'states', (select coalesce(jsonb_agg(jsonb_build_object('user', s.user_id, 'name', s.name, 'detail', s.detail, 'value', s.value, 'at', s.at)), '[]')
      from (select distinct on (user_id, name) user_id, name, detail, value, at from usage_events
              where kind = 'state' order by user_id, name, at desc, id desc) s));
end $$;

revoke execute on function public.log_usage(text, text, text, text, integer), public.usage_snapshot(uuid, date, date),
  public.admin_usage(date, date) from public, anon;
grant execute on function public.log_usage(text, text, text, text, integer), public.admin_usage(date, date) to authenticated;
