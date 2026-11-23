-- =====================================================================================================
-- Asistente: documentación del equipo (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 012.
--
-- Documentos que se suben desde Marea (guías, procesos, PDFs, Word, textos) para que el Asistente busque en ellos sin IA.
-- Se guarda el TEXTO ya extraído en el navegador (no el archivo). Cada documento es del equipo (lo ven todas las cuentas
-- activas) o privado (solo quien lo sube).
--   · Nadie lee ni escribe la tabla directamente (RLS sin reglas): todo va por las funciones de abajo.
--   · Cambiar o borrar: quien lo subió o un administrador.
--   · Máximo 600.000 caracteres por documento y 300 documentos por persona.
-- =====================================================================================================

create table if not exists public.knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  -- Si la persona se da de baja, sus documentos del equipo se quedan (los privados ya no los ve nadie).
  owner uuid references public.profiles (id) on delete set null,
  owner_name text not null default '',
  title text not null check (length(btrim(title)) between 1 and 200),
  kind text not null default 'text' check (kind in ('text', 'markdown', 'pdf', 'word', 'other')),
  file_name text not null default '',
  body text not null check (length(body) between 1 and 600000),
  visibility text not null default 'team' check (visibility in ('team', 'private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_docs_updated on public.knowledge_docs (updated_at desc);

alter table public.knowledge_docs enable row level security;
revoke all on public.knowledge_docs from anon, authenticated;

create or replace function public.knowledge_json(d public.knowledge_docs, with_body boolean) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'fileName', d.file_name, 'visibility', d.visibility,
    'ownerName', d.owner_name, 'mine', d.owner = auth.uid(), 'size', length(d.body),
    'createdAt', d.created_at, 'updatedAt', d.updated_at)
    || case when with_body then jsonb_build_object('body', d.body) else '{}'::jsonb end
$$;

/** Los documentos que veo: los del equipo y los míos privados (con su texto, para buscar en el navegador). */
create or replace function public.knowledge_docs() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(knowledge_json(d, true) order by d.updated_at desc), '[]')
    from knowledge_docs d where d.visibility = 'team' or d.owner = auth.uid());
end $$;

/** Sube un documento nuevo (p_id null) o cambia uno (solo quien lo subió o un administrador). */
create or replace function public.save_knowledge_doc(p_id uuid, p_title text, p_kind text, p_file_name text, p_body text, p_visibility text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d knowledge_docs;
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'Ponle un título al documento.'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'El documento no tiene texto.'; end if;
  if length(p_body) > 600000 then raise exception 'El documento es demasiado largo (máximo 600.000 caracteres): divídelo en partes.'; end if;
  if p_id is null then
    if (select count(*) from knowledge_docs where owner = auth.uid()) >= 300 then raise exception 'Has llegado al máximo de 300 documentos.'; end if;
    insert into knowledge_docs (owner, owner_name, title, kind, file_name, body, visibility)
      select auth.uid(), p.name, left(btrim(p_title), 200), coalesce(nullif(p_kind, ''), 'text'), left(coalesce(p_file_name, ''), 200),
        p_body, coalesce(nullif(p_visibility, ''), 'team')
        from profiles p where p.id = auth.uid()
      returning * into d;
  else
    update knowledge_docs set title = left(btrim(p_title), 200), kind = coalesce(nullif(p_kind, ''), kind),
        file_name = left(coalesce(p_file_name, file_name), 200), body = p_body,
        visibility = coalesce(nullif(p_visibility, ''), visibility), updated_at = now()
      where id = p_id and (owner = auth.uid() or is_admin())
      returning * into d;
    if d.id is null then raise exception 'Ese documento no existe o no es tuyo.'; end if;
  end if;
  return knowledge_json(d, false);
end $$;

create or replace function public.delete_knowledge_doc(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not me_active() then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  delete from knowledge_docs where id = p_id and (owner = auth.uid() or is_admin());
  if not found then raise exception 'Ese documento no existe o no es tuyo.'; end if;
end $$;

revoke execute on function public.knowledge_json(public.knowledge_docs, boolean), public.knowledge_docs(),
  public.save_knowledge_doc(uuid, text, text, text, text, text), public.delete_knowledge_doc(uuid) from public, anon;
grant execute on function public.knowledge_docs(), public.save_knowledge_doc(uuid, text, text, text, text, text),
  public.delete_knowledge_doc(uuid) to authenticated;
