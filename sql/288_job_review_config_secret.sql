-- 288 — job_review_config.cron_secret was readable by every active staff member.
--
-- The table's read policy is is_active_staff() and authenticated held table-level
-- SELECT, so the cron secret that authenticates run_job_review_monthly() →
-- job-review-notify was eleven people's secret (CLAUDE.md: a secret belongs to
-- service_role, not to staff). anon held the grants too; RLS returned no rows.
--
-- Nothing in the browser reads this table: the only consumers are the definer
-- functions (running as owner) and the job-review-notify edge function (service
-- role). So the browser roles lose it entirely rather than getting a column list.
--
-- Rotate the secret afterwards: it has already been readable.

revoke all on public.job_review_config from anon, authenticated;
