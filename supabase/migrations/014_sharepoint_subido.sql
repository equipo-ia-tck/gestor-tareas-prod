-- =====================================================================================================
-- Carpetas de SharePoint subidas desde el Mac (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después
-- de 001 a 013.
--
-- Igual que el calendario (005): un flujo de Power Automate escribe OneDrive/Gestor/sharepoint.json con la lista de
-- carpetas y archivos (solo nombre, ruta, enlace y fecha; nunca el contenido de los documentos) y el proceso del Mac lo
-- sube aquí con la misma clave de subida. Cada persona solo lee lo suyo (RLS de la 005). Aquí solo se admite el tipo
-- nuevo `sharepoint`.
-- =====================================================================================================

alter table public.connector_uploads drop constraint if exists connector_uploads_kind_check;
alter table public.connector_uploads add constraint connector_uploads_kind_check check (kind in ('calendario', 'sharepoint'));

create or replace function public.upload_connector_file(p_token text, p_kind text, p_data jsonb, p_file_at timestamptz) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_name text;
begin
  select t.owner, p.name into v_owner, v_name
    from upload_tokens t join profiles p on p.id = t.owner
   where t.token_hash = upload_token_hash(coalesce(p_token, '')) and not p.disabled;
  if v_owner is null then raise exception 'Clave de subida no válida: genera otra en Ajustes → Calendario de Outlook.' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('calendario', 'sharepoint') then raise exception 'Tipo de archivo no admitido.'; end if;
  if jsonb_typeof(p_data) is distinct from 'array' then raise exception 'Se esperaba una lista.'; end if;
  if pg_column_size(p_data) > 5 * 1024 * 1024 then
    raise exception '%', case when p_kind = 'sharepoint' then 'La lista de SharePoint es demasiado grande: deja menos carpetas en el flujo.'
      else 'El calendario es demasiado grande.' end;
  end if;
  insert into connector_uploads (owner, kind, data, file_at, uploaded_at) values (v_owner, p_kind, p_data, p_file_at, now())
    on conflict (owner, kind) do update set data = excluded.data, file_at = excluded.file_at, uploaded_at = now();
  return v_name;
end $$;

revoke execute on function public.upload_connector_file(text, text, jsonb, timestamptz) from public;
grant execute on function public.upload_connector_file(text, text, jsonb, timestamptz) to anon, authenticated;
