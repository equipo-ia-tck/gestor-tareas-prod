-- =====================================================================================================
-- Claude lee las carpetas de SharePoint guardadas en Marea (nov 2026, visto bueno de José). Se pega en Supabase → SQL Editor
-- → New query → Run, después de 001 a 017.
--
-- El conector MCP corre en Vercel y no tiene la sesión de SharePoint de nadie: la tiene la extensión de Chrome de cada
-- persona. Así que la petición pasa por aquí, de paso:
--   1. Claude pide algo (ver una carpeta, buscar, leer un archivo) → el conector llama a `sp_request` con la sesión de la
--      persona y espera.
--   2. La pestaña de Marea de esa persona (con «Dejar que Claude lea mis carpetas» activado) se entera por tiempo real,
--      la coge con `sp_take`, comprueba que es de una carpeta guardada, lo hace con la extensión y contesta con `sp_answer`.
--   3. El conector recoge la respuesta con `sp_collect`, que **borra la fila**. Nada se queda: lo que no se recoge se borra
--      a los 10 minutos.
-- Cada persona solo ve y contesta sus propias peticiones.
-- =====================================================================================================

create table if not exists public.sp_requests (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles (id) on delete cascade,
  op text not null check (op in ('folder', 'search', 'read')),
  args jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'working', 'done', 'error')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sp_requests_owner on public.sp_requests (owner, created_at);

alter table public.sp_requests enable row level security;
drop policy if exists sp_requests_select on public.sp_requests;
create policy sp_requests_select on public.sp_requests for select to authenticated
  using (owner = auth.uid() and public.me_active());
revoke all on public.sp_requests from anon, authenticated;
grant select on public.sp_requests to authenticated;

-- Tiempo real: la pestaña de Marea se entera al momento (las pestañas ocultas espacian los temporizadores).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sp_requests') then
    alter publication supabase_realtime add table public.sp_requests;
  end if;
end $$;

/** Nueva petición de Claude (la llama el conector con la sesión de la persona). Devuelve su id. */
create or replace function public.sp_request(p_op text, p_args jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_op not in ('folder', 'search', 'read') then raise exception 'Petición no válida.'; end if;
  if jsonb_typeof(coalesce(p_args, '{}'::jsonb)) <> 'object' or length(coalesce(p_args, '{}'::jsonb)::text) > 4000 then
    raise exception 'Petición no válida.';
  end if;
  delete from sp_requests where owner = auth.uid() and created_at < now() - interval '10 minutes';
  if (select count(*) from sp_requests where owner = auth.uid()) >= 30 then
    raise exception 'Demasiadas peticiones a SharePoint seguidas: espera un momento.';
  end if;
  insert into sp_requests (owner, op, args) values (auth.uid(), p_op, coalesce(p_args, '{}'::jsonb)) returning id into v_id;
  return v_id;
end $$;

/** Peticiones pendientes de la persona (la pestaña de Marea, al abrirse o si se ha cortado el tiempo real). */
create or replace function public.sp_pending() returns jsonb
language sql security definer set search_path = public stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'op', op, 'args', args) order by created_at), '[]'::jsonb)
  from sp_requests
  where owner = auth.uid() and me_active() and status = 'pending' and created_at > now() - interval '2 minutes';
$$;

/** La pestaña coge una petición (solo una pestaña la hace: la primera que llega). Null si ya no está pendiente. */
create or replace function public.sp_take(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v sp_requests;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  update sp_requests set status = 'working', updated_at = now()
    where id = p_id and owner = auth.uid() and status = 'pending' and created_at > now() - interval '2 minutes'
    returning * into v;
  if v.id is null then return null; end if;
  return jsonb_build_object('id', v.id, 'op', v.op, 'args', v.args);
end $$;

/** La pestaña contesta: el resultado (máx. 1 MB) o el error. */
create or replace function public.sp_answer(p_id uuid, p_result jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_result is not null and length(p_result::text) > 1000000 then
    p_result := null;
    p_error := 'La respuesta de SharePoint es demasiado grande.';
  end if;
  update sp_requests
    set status = case when p_error is null or p_error = '' then 'done' else 'error' end,
        result = case when p_error is null or p_error = '' then p_result end,
        error = nullif(left(coalesce(p_error, ''), 500), ''),
        updated_at = now()
    where id = p_id and owner = auth.uid() and status = 'working';
end $$;

/** El conector recoge la respuesta: si ya está, la devuelve y borra la fila; si no, solo su estado. */
create or replace function public.sp_collect(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v sp_requests;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  select * into v from sp_requests where id = p_id and owner = auth.uid();
  if v.id is null then return jsonb_build_object('status', 'gone'); end if;
  if v.status in ('done', 'error') then
    delete from sp_requests where id = p_id;
    return jsonb_build_object('status', v.status, 'result', v.result, 'error', v.error);
  end if;
  return jsonb_build_object('status', v.status);
end $$;

/** El conector se cansa de esperar: la petición se borra (si la pestaña contesta después, ya no queda nada). */
create or replace function public.sp_cancel(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from sp_requests where id = p_id and owner = auth.uid();
$$;

revoke execute on function public.sp_request(text, jsonb), public.sp_pending(), public.sp_take(uuid),
  public.sp_answer(uuid, jsonb, text), public.sp_collect(uuid), public.sp_cancel(uuid) from public, anon;
grant execute on function public.sp_request(text, jsonb), public.sp_pending(), public.sp_take(uuid),
  public.sp_answer(uuid, jsonb, text), public.sp_collect(uuid), public.sp_cancel(uuid) to authenticated;
