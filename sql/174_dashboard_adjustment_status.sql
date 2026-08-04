-- 174_dashboard_adjustment_status.sql
-- Underlying Performance — remember which suggested owner-cost codes we said no to.
--
-- The tab now scans the client's QBO nominal hierarchy and suggests codes that
-- look like director personal items (dividends, director's salary, home office,
-- drawings). A human ticks the ones that really are personal. The ones they
-- reject must stay rejected, otherwise the same suggestion reappears on every
-- visit — so a rejection is stored as a row on the same table with
-- status = 'dismissed'.
--
--   status = 'active'    → tagged owner cost, added back in the maths (default,
--                          so every existing row keeps its current meaning)
--   status = 'dismissed' → reviewed and judged NOT a personal item; never
--                          suggested again, never added back
--
-- Keeping both states on one table means the existing
-- unique (realm_id, group_key, account_id) constraint does the deduping, and
-- confirming a previously dismissed code is a plain upsert back to 'active'.

alter table dashboard_adjustment_accounts
  add column if not exists status text not null default 'active';

alter table dashboard_adjustment_accounts
  drop constraint if exists dashboard_adjustment_accounts_status_check;
alter table dashboard_adjustment_accounts
  add constraint dashboard_adjustment_accounts_status_check
  check (status in ('active', 'dismissed'));

-- Where the suggestion came from, so we can tell an auto-suggested code that a
-- human confirmed from one somebody picked by hand. Null = added manually.
alter table dashboard_adjustment_accounts
  add column if not exists suggested_rule text;

create index if not exists idx_dash_adj_accounts_realm_status
  on dashboard_adjustment_accounts(realm_id, group_key, status);
