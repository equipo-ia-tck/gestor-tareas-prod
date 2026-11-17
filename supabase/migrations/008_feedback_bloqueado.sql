-- =====================================================================================================
-- Feedback: estado «Bloqueado» (nov 2026). Se pega en Supabase → SQL Editor → New query → Run, después de 007.
--
-- El tablero de Más → Feedback tiene cinco columnas: Nuevo, En curso, Bloqueado, Hecho y Descartado.
-- Solo cambia la regla de estados; las funciones (admin_update_feedback…) siguen igual.
-- =====================================================================================================

alter table public.feedback drop constraint if exists feedback_status_check;
alter table public.feedback add constraint feedback_status_check check (status in ('new', 'doing', 'blocked', 'done', 'dismissed'));
