-- =====================================================================================================
-- Feedback de los usuarios (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 005.
--
-- Cualquier cuenta activa envía mejoras, cosas rotas u otros comentarios con el botón flotante de la app. Solo los
-- administradores los leen (Más → Feedback), les cambian el estado y los convierten en tareas.
--   · Nadie lee ni escribe la tabla directamente (RLS sin reglas): todo va por las funciones de abajo.
--   · Se guarda quién lo envía (nombre y usuario en el momento), desde qué pantalla y con qué navegador.
--   · Si la persona se da de baja, su feedback se queda (sin enlace a la cuenta).
-- =====================================================================================================

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  author uuid references public.profiles (id) on delete set null,
  author_name text not null default '',
  author_login text not null default '',
  kind text not null check (kind in ('improvement', 'bug', 'other')),
  body text not null check (length(btrim(body)) between 1 and 5000),
  page text not null default '',
  user_agent text not null default '',
  status text not null default 'new' check (status in ('new', 'doing', 'done', 'dismissed')),
  task_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_created on public.feedback (created_at desc);

alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;

create or replace function public.feedback_json(f public.feedback) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', f.id, 'authorName', f.author_name, 'authorLogin', f.author_login, 'kind', f.kind,
    'body', f.body, 'page', f.page, 'userAgent', f.user_agent, 'status', f.status, 'taskId', f.task_id,
    'createdAt', f.created_at, 'updatedAt', f.updated_at)
$$;

create or replace function public.send_feedback(p_kind text, p_body text, p_page text, p_user_agent text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'Escribe qué quieres contarnos.'; end if;
  if (select count(*) from feedback where author = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Has enviado mucho feedback en la última hora. Prueba un poco más tarde.';
  end if;
  insert into feedback (author, author_name, author_login, kind, body, page, user_agent)
    select auth.uid(), p.name, p.login, p_kind, left(btrim(p_body), 5000), left(coalesce(p_page, ''), 300), left(coalesce(p_user_agent, ''), 400)
      from profiles p where p.id = auth.uid();
end $$;

create or replace function public.admin_feedback() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return (select coalesce(jsonb_agg(feedback_json(f) order by f.created_at desc), '[]') from feedback f);
end $$;

create or replace function public.admin_update_feedback(p_id uuid, p_status text, p_task_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f feedback;
begin
  perform require_admin();
  update feedback set status = coalesce(p_status, status), task_id = coalesce(p_task_id, task_id), updated_at = now()
    where id = p_id returning * into f;
  if f.id is null then raise exception 'Ese feedback ya no existe.'; end if;
  return feedback_json(f);
end $$;

revoke execute on function public.feedback_json(public.feedback), public.send_feedback(text, text, text, text),
  public.admin_feedback(), public.admin_update_feedback(uuid, text, text) from public, anon;
grant execute on function public.send_feedback(text, text, text, text), public.admin_feedback(),
  public.admin_update_feedback(uuid, text, text) to authenticated;
