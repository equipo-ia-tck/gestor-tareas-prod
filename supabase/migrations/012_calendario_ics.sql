-- =====================================================================================================
-- Otro calendario por enlace ICS (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 001 a 011.
--
-- Para ver en el gestor un segundo calendario publicado (p. ej. el de La Caixa, que trae los títulos de las reuniones)
-- desde la app publicada: la función de Vercel guarda el enlace de cada persona en `connector_accounts`, CIFRADO con
-- el mismo secreto que Rally (RALLY_SECRET, solo en Vercel). Aquí solo se permite el nuevo conector `calendario-ics`;
-- las funciones de la 004 (my_connector, set_my_connector, delete_my_connector) ya sirven: cada persona, la suya.
-- =====================================================================================================

alter table public.connector_accounts drop constraint if exists connector_accounts_connector_check;
alter table public.connector_accounts add constraint connector_accounts_connector_check
  check (connector in ('rally', 'calendario-ics'));
