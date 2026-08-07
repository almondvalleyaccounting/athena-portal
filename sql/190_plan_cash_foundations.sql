-- 190: Cash & Owner page foundations (Planning overhaul Phase 3).
--
-- plan_bs_cache — a generic mirror of QBO's Balance Sheet report, one row
-- per leaf account per snapshot date, written by planning-qbo-pull v11
-- (granularity: 'balance_sheet'). The client classifies rows by section +
-- name pattern (BankAccounts → cash, /vat/i → VAT provision, etc.) so an
-- unexpected account shows up visibly instead of vanishing into a bucket.
--
-- plan_scenarios gains the cash assumptions Bobby set on 2026-08-07:
--   debtor days 30 · floor = 6 months payroll · VAT quarters Mar/Jun/Sep/Dec
--   (derived from month % 3, no column needed) · PAYE ~30% of gross payroll
--   paid on the 22nd · ~70% of overheads VATable · firm year-end month
--   (March default — EDITABLE, not confirmed from CH).

create table if not exists plan_bs_cache (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  account_name text not null,
  section text not null,
  amount numeric not null default 0,
  fetched_at timestamptz not null default now()
);

create index if not exists plan_bs_cache_snapshot_idx on plan_bs_cache (snapshot_date desc);

alter table plan_bs_cache enable row level security;

drop policy if exists plan_bs_cache_read on plan_bs_cache;
create policy plan_bs_cache_read on plan_bs_cache
  for select to authenticated using (true);
-- No insert/update/delete policies: only the service role (edge function)
-- writes this mirror.

alter table plan_scenarios
  add column if not exists cash_debtor_days int not null default 30,
  add column if not exists cash_floor_months numeric not null default 6,
  add column if not exists cash_paye_pct numeric not null default 30,
  add column if not exists cash_overhead_vatable_pct numeric not null default 70,
  add column if not exists fiscal_year_end_month int not null default 3;

comment on column plan_scenarios.cash_floor_months is
  'Safe-draw floor: this many months of payroll must remain AFTER ring-fencing VAT and CT provisions to the report date.';
comment on column plan_scenarios.fiscal_year_end_month is
  'Firm''s own accounting year-end month (1-12). Drives the CT payment date (YE + 9 months + 1 day). Default March = a guess, not confirmed.';
