-- =====================================================================================================
-- Editar una solicitud propia mientras está en «Nuevo» (feedback, nov 2026). Se pega en Supabase → SQL Editor → New query
-- → Run, después de 001 a 018 (necesita 016 y 017: `feedback_json` y `my_feedback`).
--
-- En «Mis solicitudes», quien envió algo puede cambiar el tipo, la parte de la web, la frase, el detalle y el impacto hasta
-- que un administrador lo mira (En curso, Bloqueado, Hecho o Descartado). Lo comprueba la base de datos, no solo la pantalla.
-- =====================================================================================================

create or replace function public.edit_my_feedback(p_id uuid, p_kind text, p_area text, p_title text, p_body text, p_impact text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v feedback;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('bug', 'improvement', 'idea', 'question') then raise exception 'Tipo de solicitud no válido.'; end if;
  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'Escribe en una frase qué pasa o qué propones.'; end if;
  if p_area is null or length(btrim(p_area)) = 0 then raise exception 'Elige de qué parte de la web es.'; end if;
  update feedback set
      kind = p_kind,
      area = left(btrim(p_area), 60),
      title = left(btrim(p_title), 200),
      body = left(btrim(coalesce(p_body, '')), 5000),
      impact = case when p_kind = 'bug' then nullif(p_impact, '') end,
      updated_at = now()
    where id = p_id and author = auth.uid() and status = 'new'
    returning * into v;
  if v.id is null then
    raise exception 'Solo puedes editar tus solicitudes mientras están en «Nuevo».' using errcode = '42501';
  end if;
  return feedback_json(v) - 'userAgent' - 'taskId' - 'authorLogin' - 'rank';
end $$;

revoke execute on function public.edit_my_feedback(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.edit_my_feedback(uuid, text, text, text, text, text) to authenticated;
