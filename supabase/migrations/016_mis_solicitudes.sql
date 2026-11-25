-- =====================================================================================================
-- Feedback: «Mis solicitudes» (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 006 a 008.
--
-- Cada persona ve lo que ha enviado con el botón «Feedback» y en qué estado está (Nuevo, En curso, Bloqueado, Hecho o
-- Descartado), con la respuesta del administrador si la hay. Sigue sin poder leer lo de los demás.
--   · `my_feedback()`: lo propio, sin el navegador.
--   · `admin_reply_feedback(id, texto)`: solo administradores; texto vacío quita la respuesta.
-- =====================================================================================================

alter table public.feedback add column if not exists reply text not null default '';
alter table public.feedback add column if not exists reply_at timestamptz;
create index if not exists feedback_author on public.feedback (author, created_at desc);

create or replace function public.feedback_json(f public.feedback) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', f.id, 'authorName', f.author_name, 'authorLogin', f.author_login, 'kind', f.kind,
    'title', f.title, 'area', f.area, 'impact', f.impact, 'body', f.body, 'page', f.page, 'screen', f.screen,
    'userAgent', f.user_agent, 'status', f.status, 'taskId', f.task_id, 'reply', f.reply, 'replyAt', f.reply_at,
    'createdAt', f.created_at, 'updatedAt', f.updated_at)
$$;

create or replace function public.my_feedback() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(
      feedback_json(f) - 'userAgent' - 'taskId' - 'authorLogin' order by f.created_at desc), '[]')
    from feedback f where f.author = auth.uid());
end $$;

create or replace function public.admin_reply_feedback(p_id uuid, p_reply text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f feedback; r text := left(btrim(coalesce(p_reply, '')), 2000);
begin
  perform require_admin();
  update feedback set reply = r, reply_at = case when r = '' then null else now() end, updated_at = now()
    where id = p_id returning * into f;
  if f.id is null then raise exception 'Ese feedback ya no existe.'; end if;
  return feedback_json(f);
end $$;

revoke execute on function public.my_feedback(), public.admin_reply_feedback(uuid, text) from public, anon;
grant execute on function public.my_feedback(), public.admin_reply_feedback(uuid, text) to authenticated;
