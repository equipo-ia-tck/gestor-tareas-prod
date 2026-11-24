-- =====================================================================================================
-- Respuestas de Claude en el Asistente (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 014.
--
-- «Preguntar a Claude» abre Claude con la pregunta y un id; Claude, con el conector MCP de Marea, guarda su respuesta con la
-- herramienta `responder_en_marea`, y el Asistente de Marea la recoge y la enseña. Claude y la pestaña de Marea no pueden
-- hablar directamente, así que la respuesta pasa por aquí.
--   · `assistant_answers`: una fila por pregunta (el id lo pone Marea). Cada persona solo lee las suyas.
--   · `save_assistant_answer`: la llama el conector con la sesión de la persona. Borra las suyas de hace más de 30 días.
-- =====================================================================================================

create table if not exists public.assistant_answers (
  id text primary key check (id ~ '^[a-z0-9-]{6,64}$'),
  owner uuid not null references public.profiles (id) on delete cascade,
  question text not null default '',
  answer text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_answers_owner on public.assistant_answers (owner, created_at);

alter table public.assistant_answers enable row level security;
drop policy if exists assistant_answers_select on public.assistant_answers;
create policy assistant_answers_select on public.assistant_answers for select to authenticated
  using (owner = auth.uid() and public.me_active());
revoke all on public.assistant_answers from anon, authenticated;
grant select on public.assistant_answers to authenticated;

/** Guarda (o sustituye) la respuesta de Claude a una pregunta de la persona conectada. */
create or replace function public.save_assistant_answer(p_id text, p_question text, p_answer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_id is null or p_id !~ '^[a-z0-9-]{6,64}$' then raise exception 'Id de pregunta no válido.'; end if;
  if coalesce(length(p_answer), 0) = 0 then raise exception 'La respuesta está vacía.'; end if;
  if length(p_answer) > 100000 or length(coalesce(p_question, '')) > 4000 then raise exception 'La respuesta es demasiado larga.'; end if;
  select owner into v_owner from assistant_answers where id = p_id;
  if v_owner is not null and v_owner <> auth.uid() then raise exception 'Esa pregunta no es tuya.' using errcode = '42501'; end if;
  insert into assistant_answers (id, owner, question, answer) values (p_id, auth.uid(), coalesce(p_question, ''), p_answer)
    on conflict (id) do update set answer = excluded.answer,
      question = case when excluded.question <> '' then excluded.question else assistant_answers.question end,
      updated_at = now();
  delete from assistant_answers where owner = auth.uid() and created_at < now() - interval '30 days';
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

revoke execute on function public.save_assistant_answer(text, text, text) from public, anon;
grant execute on function public.save_assistant_answer(text, text, text) to authenticated;
