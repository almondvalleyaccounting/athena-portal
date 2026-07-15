-- 107_qbo_dashboard.sql
-- Client Dashboard from QuickBooks — Phase A foundations.
-- Applied as migration `qbo_dashboard_v1` (15/07/2026).
--
-- Two new tables:
--   qbo_report_tokens  — per-realm OAuth tokens for pulling live data for MANY
--                        clients. Kept SEPARATE from qbo_report_connections
--                        because that table is staff-readable (RLS:
--                        is_active_staff() can SELECT) and tokens must never be
--                        client/staff-readable. RLS enabled + NO policies →
--                        service-role (edge functions) only.
--   qbo_dashboard_cache — cached metric payloads per client (cached + refresh
--                        model). Staff-readable, mirrors plan_qbo_pl_cache.

create table if not exists qbo_report_tokens (
  realm_id                  text primary key,
  access_token              text,
  refresh_token             text,
  token_expires_at          timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  status                    text default 'active',
  error_message             text,
  last_refreshed_at         timestamptz,
  connected_by              uuid,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);
alter table qbo_report_tokens enable row level security;
-- (deliberately no policies — service-role access only)

create table if not exists qbo_dashboard_cache (
  id            uuid primary key default gen_random_uuid(),
  realm_id      text not null,
  metric_key    text not null,       -- e.g. 'company', 'pl_summary', 'file_health'
  period_start  date,
  period_end    date,
  data          jsonb not null default '{}'::jsonb,
  pulled_at     timestamptz not null default now()
);
create index if not exists idx_qbo_dashboard_cache_realm on qbo_dashboard_cache(realm_id, metric_key);
alter table qbo_dashboard_cache enable row level security;
create policy "staff read dashboard cache" on qbo_dashboard_cache
  for select to authenticated using (is_active_staff());
