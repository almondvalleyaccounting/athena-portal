-- 147_dashboard_custom_analysis.sql
-- Client Dashboard — custom analysis (owner adjustments → underlying performance).
--
-- Two per-client (per-realm) config tables driving the "Underlying performance"
-- tab, which normalises reported profit to what the business earns for the
-- owner:
--   dashboard_adjustment_accounts — QBO nominal codes tagged into an adjustment
--     GROUP (owner_costs today; group_key leaves room for more groups / custom
--     hierarchies later). The tab sums each tagged account's P&L amount over the
--     selected period and adds it back.
--   dashboard_oneoff_items — dated one-off cost / income entries (add back costs,
--     strip income) so a single unusual transaction doesn't distort the run-rate.
--
-- Both are keyed on realm_id and secured like qbo_dashboard_cache: any active
-- staff member may read/write, AND a restrictive practice policy hides/locks
-- AVA's own books (is_practice_realm) unless can_view_practice_financials.

create table if not exists dashboard_adjustment_accounts (
  id           uuid primary key default gen_random_uuid(),
  realm_id     text not null,
  group_key    text not null default 'owner_costs',
  account_id   text not null,           -- QBO Account.Id (matches P&L row id)
  acct_num     text,                    -- QBO Account.AcctNum (nominal code)
  account_name text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (realm_id, group_key, account_id)
);
create index if not exists idx_dash_adj_accounts_realm
  on dashboard_adjustment_accounts(realm_id, group_key);

create table if not exists dashboard_oneoff_items (
  id           uuid primary key default gen_random_uuid(),
  realm_id     text not null,
  kind         text not null check (kind in ('cost', 'income')),
  entry_date   date not null,
  amount       numeric not null,
  acct_num     text,
  account_id   text,
  account_name text,
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists idx_dash_oneoff_realm
  on dashboard_oneoff_items(realm_id, entry_date);

-- RLS ---------------------------------------------------------------------
alter table dashboard_adjustment_accounts enable row level security;
alter table dashboard_oneoff_items enable row level security;

drop policy if exists "staff manage adjustment accounts" on dashboard_adjustment_accounts;
create policy "staff manage adjustment accounts" on dashboard_adjustment_accounts
  for all to authenticated
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists "practice adjustment accounts gated" on dashboard_adjustment_accounts;
create policy "practice adjustment accounts gated" on dashboard_adjustment_accounts
  as restrictive for all to authenticated
  using (not is_practice_realm(realm_id) or can_view_practice_financials())
  with check (not is_practice_realm(realm_id) or can_view_practice_financials());

drop policy if exists "staff manage oneoff items" on dashboard_oneoff_items;
create policy "staff manage oneoff items" on dashboard_oneoff_items
  for all to authenticated
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists "practice oneoff items gated" on dashboard_oneoff_items;
create policy "practice oneoff items gated" on dashboard_oneoff_items
  as restrictive for all to authenticated
  using (not is_practice_realm(realm_id) or can_view_practice_financials())
  with check (not is_practice_realm(realm_id) or can_view_practice_financials());
