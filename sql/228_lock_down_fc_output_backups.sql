-- 228: close the Supabase advisor CRITICAL (rls_disabled_in_public)
--
-- The 2026-08-14 forecast rework left two fc_output backup tables behind in the
-- public schema. Public-schema tables get the default anon/authenticated grants,
-- and RLS was never enabled on these, so the whole of both tables — client
-- forecast lines keyed by entity_id — was readable AND writable (including
-- DELETE and TRUNCATE) by anyone holding the anon key, which ships in the
-- frontend bundle and is public by design.
--
-- Nothing in the app or in any migration reads these tables. Deny-all: strip the
-- API-role grants and enable RLS with no policies. service_role (edge functions,
-- migrations, pg_cron) bypasses RLS, so the backups stay available to us.

revoke all on public.fc_output_backup_20260814 from anon, authenticated;
revoke all on public.fc_output_backup_20260814_tax from anon, authenticated;

alter table public.fc_output_backup_20260814 enable row level security;
alter table public.fc_output_backup_20260814_tax enable row level security;
