-- =====================================================================================================
-- Feedback con formulario (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 006.
--
-- El botón «Feedback» pide ahora tipo (Algo no funciona · Mejora · Idea nueva · Duda), parte de la web, una frase,
-- el detalle (opcional) y, si algo no funciona, cuánto afecta. Se guarda también el tamaño de pantalla.
-- Lo enviado antes se conserva (tipo «other» incluido). Sigue igual: solo los administradores lo leen.
-- =====================================================================================================

alter table public.feedback add column if not exists title text not null default '';
alter table public.feedback add column if not exists area text not null default '';
alter table public.feedback add column if not exists impact text check (impact in ('blocking', 'annoying', 'minor'));
alter table public.feedback add column if not exists screen text not null default '';

alter table public.feedback drop constraint if exists feedback_kind_check;
alter table public.feedback add constraint feedback_kind_check check (kind in ('bug', 'improvement', 'idea', 'question', 'other'));
-- El detalle pasa a ser opcional (lo obligatorio es la frase).
alter table public.feedback drop constraint if exists feedback_body_check;
alter table public.feedback add constraint feedback_body_check check (length(body) <= 5000);

create or replace function public.feedback_json(f public.feedback) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', f.id, 'authorName', f.author_name, 'authorLogin', f.author_login, 'kind', f.kind,
    'title', f.title, 'area', f.area, 'impact', f.impact, 'body', f.body, 'page', f.page, 'screen', f.screen,
    'userAgent', f.user_agent, 'status', f.status, 'taskId', f.task_id, 'createdAt', f.created_at, 'updatedAt', f.updated_at)
$$;

create or replace function public.send_feedback_form(p_kind text, p_area text, p_title text, p_body text, p_impact text,
  p_page text, p_screen text, p_user_agent text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'Escribe en una frase qué pasa o qué propones.'; end if;
  if p_area is null or length(btrim(p_area)) = 0 then raise exception 'Elige de qué parte de la web es.'; end if;
  if (select count(*) from feedback where author = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Has enviado mucho feedback en la última hora. Prueba un poco más tarde.';
  end if;
  insert into feedback (author, author_name, author_login, kind, area, title, body, impact, page, screen, user_agent)
    select auth.uid(), p.name, p.login, p_kind, left(btrim(p_area), 60), left(btrim(p_title), 200), left(btrim(coalesce(p_body, '')), 5000),
      case when p_kind = 'bug' then nullif(p_impact, '') end,
      left(coalesce(p_page, ''), 300), left(coalesce(p_screen, ''), 40), left(coalesce(p_user_agent, ''), 400)
      from profiles p where p.id = auth.uid();
end $$;

revoke execute on function public.send_feedback_form(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.send_feedback_form(text, text, text, text, text, text, text, text) to authenticated;
