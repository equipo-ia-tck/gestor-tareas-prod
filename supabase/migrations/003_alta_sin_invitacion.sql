-- =====================================================================================================
-- Alta sin invitación (nov 2026, espacios apagados en la app). Se pega en Supabase → SQL Editor → Run, después de 002.
--   · La primera cuenta es administradora; el código de administración, si alguien lo escribe, sigue creando administradores.
--   · Sin código (o con uno que no es de nada) se entra como usuario normal, sin espacio.
--   · Si el código es la invitación de un espacio, se entra en ese espacio (por si se vuelven a usar).
-- =====================================================================================================

create or replace function public.register_profile(p_name text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_space uuid;
  v_admin boolean;
begin
  if uid is null then raise exception 'Inicia sesión.' using errcode = '42501'; end if;
  if exists (select 1 from profiles where id = uid) then return me(); end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Escribe tu nombre completo (es el que se usa al mencionarte).'; end if;
  v_admin := not exists (select 1 from profiles) or (v_code <> '' and v_code = (select v from app_settings where k = 'admin_code'));
  if not v_admin and v_code <> '' then select id into v_space from spaces where invite_code = v_code; end if;
  insert into profiles (id, login, name, is_admin) values (uid, lower(coalesce(auth.email(), uid::text)), trim(p_name), v_admin);
  if v_space is not null then insert into space_members values (v_space, uid, 'member'); end if;
  return me();
end $$;
