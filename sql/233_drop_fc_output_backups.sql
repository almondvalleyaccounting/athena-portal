-- 233: drop the stale forecast backups from the 2026-08-14 rework.
--
-- 42,801 rows each; live fc_output has since been rebuilt to 55,362 rows, so these
-- are superseded, not a fallback. The rework is shipped and committed, and nothing
-- in the app or in any migration references them.
--
-- 228 locked them down (RLS on, API grants revoked) but locking down a table nobody
-- needs still leaves the liability sitting there. Removing it is the actual fix.

drop table if exists public.fc_output_backup_20260814;
drop table if exists public.fc_output_backup_20260814_tax;
