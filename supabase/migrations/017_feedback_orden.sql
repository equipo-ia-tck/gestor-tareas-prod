-- =====================================================================================================
-- Feedback: orden de prioridad (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 016.
--
-- Los administradores ordenan el feedback a mano (arrastrando o con las flechas en Más → Feedback): lo de arriba es lo
-- primero que hay que hacer. Lo que aún no se ha ordenado sale arriba del todo, el más nuevo primero, para verlo.
--   · `rank`: posición (1 = lo más importante); null = sin ordenar.
--   · `admin_order_feedback(ids)`: solo administradores; pone a cada id su posición en la lista. No cambia `updated_at`
--     (es la fecha del último cambio de estado que ve quien lo envió y la que usa el panel).
-- =====================================================================================================

alter table public.feedback add column if not exists rank integer;

create or replace function public.feedback_json(f public.feedback) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', f.id, 'authorName', f.author_name, 'authorLogin', f.author_login, 'kind', f.kind,
    'title', f.title, 'area', f.area, 'impact', f.impact, 'body', f.body, 'page', f.page, 'screen', f.screen,
    'userAgent', f.user_agent, 'status', f.status, 'taskId', f.task_id, 'reply', f.reply, 'replyAt', f.reply_at,
    'rank', f.rank, 'createdAt', f.created_at, 'updatedAt', f.updated_at)
$$;

create or replace function public.my_feedback() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(
      feedback_json(f) - 'userAgent' - 'taskId' - 'authorLogin' - 'rank' order by f.created_at desc), '[]')
    from feedback f where f.author = auth.uid());
end $$;

create or replace function public.admin_order_feedback(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if coalesce(array_length(p_ids, 1), 0) > 5000 then raise exception 'Demasiados elementos.'; end if;
  update feedback f set rank = o.pos from unnest(p_ids) with ordinality as o(id, pos) where f.id = o.id;
end $$;

revoke execute on function public.admin_order_feedback(uuid[]) from public, anon;
grant execute on function public.admin_order_feedback(uuid[]) to authenticated;
