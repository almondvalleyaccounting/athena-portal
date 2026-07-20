-- 131_client_dashboard_v2.sql
-- Client Dashboard v2 — snapshot history for month-on-month comparisons.
--
-- dashboard-qbo-pull now writes one row per (realm_id, metric_key, period_end)
-- via UPSERT instead of delete+insert, so aged-debt / balance-sheet snapshots
-- accumulate over time and the UI can compare the latest snapshot against the
-- most recent one from a previous calendar month.
--
-- The function always stamps a non-null period_end going forward (falling back
-- to the pull date for point-in-time metrics), so the unique index below is the
-- upsert conflict target. Reads are already covered by the existing
-- "staff read dashboard cache" SELECT policy from sql/107 (is_active_staff()).
-- Writes remain service-role only (edge function).

-- Defensive dedupe before adding the unique index: keep the newest row per
-- (realm_id, metric_key, period_end). The old delete+insert flow kept a single
-- row per (realm, metric) so real duplicates are unlikely, but be safe.
delete from qbo_dashboard_cache a
using qbo_dashboard_cache b
where a.realm_id = b.realm_id
  and a.metric_key = b.metric_key
  and coalesce(a.period_end, '1900-01-01') = coalesce(b.period_end, '1900-01-01')
  and (a.pulled_at < b.pulled_at
       or (a.pulled_at = b.pulled_at and a.ctid < b.ctid));

-- Upsert conflict target. NULL period_end rows (legacy) stay outside the
-- constraint (NULLs are distinct); the function cleans those up per metric as
-- it writes fresh snapshots.
create unique index if not exists uq_qbo_dashboard_cache_snapshot
  on qbo_dashboard_cache (realm_id, metric_key, period_end);

-- Helper for "latest snapshot per metric" reads (page + portfolio).
create index if not exists idx_qbo_dashboard_cache_pulled
  on qbo_dashboard_cache (realm_id, metric_key, pulled_at desc);
