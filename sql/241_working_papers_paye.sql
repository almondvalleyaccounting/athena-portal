-- 241 — Working Papers: the PAYE three-way, and the mapping it needs.
--
-- A working paper is not a dashboard. It answers one question — "does this
-- balance agree, and if not, why" — and it has to hold up to a reviewer six
-- months later. So every figure here carries its own source and its own basis,
-- and nothing is netted off until the paper says why.
--
-- THREE LEGS for PAYE:
--
--   HMRC        what the taxman's own account says (the `hmrc` scrape schema)
--   QuickBooks  what the client's ledger says (the PAYE control nominal, plus
--               CIS suffered and CIS withheld where they are carried separately)
--   BrightPay   what the payroll itself produced (the HMRC Payments / P32 screen)
--
-- Two of those three already exist in Athena. The HMRC leg is the scrape; the
-- QuickBooks leg needs to know WHICH nominal, per client, which is what
-- wp_nominal_map is for. The BrightPay leg is declared here and fed later — the
-- runner's readTaxMonth() already reads most of it but persists only the net
-- amount due and the EA claim, so wp_brightpay_period is deliberately empty
-- until the runner is extended. An empty leg reads as "not fed", never as zero.
--
-- ── WHY THE PAPER HAS TWO PANELS ────────────────────────────────────────────
--
-- PAYE does not respect a company's year end, and CIS respects it even less.
--
--   The BALANCE SHEET panel is on the accounting year end. It answers "is the
--   PAYE creditor in the accounts right", and its HMRC leg is
--   hmrc_paye_balance_at() from sql/239 — which already knows that a 31 January
--   year end accrues the tax month ending 5 February.
--
--   The TAX YEAR panel is on 6 April – 5 April, because that is the only period
--   in which a CIS deduction suffered can be set against a PAYE liability at
--   all. A company with a December year end still has its CIS offset capacity
--   reset every 6 April, mid-way through its own year. Presenting CIS on the
--   accounting year would be arithmetically tidy and professionally wrong.
--
-- ── THE FINDING THAT DRIVES THE DESIGN ──────────────────────────────────────
--
-- Measured on the live scrape, 19 Aug 2026: of 36 CIS-suffered credit lines on
-- the latest run, 20 sit against a tax month that is NOT the month their own
-- label says they relate to, and one crosses a tax year — Antonine Builders
-- carries £678.34 recorded in 2026-27 month 3 for a deduction suffered in
-- 2022-23 month 7.
--
-- So CIS credits CANNOT be matched to BrightPay month by month. HMRC records
-- the credit in the month it processed the EPS and labels it with the month it
-- relates to, and the two differ in both directions: a late claim lands in a
-- later month, and HMRC sometimes back-dates onto an earlier one. Any check
-- that joins on tax_month alone manufactures a variance on more than half the
-- population.
--
-- The rule this schema takes instead:
--
--   * match on TAX YEAR, never on tax month, for anything CIS
--   * carry "recorded in" and "relates to" as two separate facts, and show the
--     difference as its own reconciling line rather than a variance
--   * a credit whose relates-to year is a PRIOR year is not a variance and not
--     an error. It is a prior-year deduction that could not be offset in its own
--     year and has surfaced here. It reduces THIS year's liability and must
--     never be expected to appear in this year's payroll.
--
-- See docs/hmrc-timing-and-cis-rules.md for the rules this encodes and the
-- authority for each.

begin;

-- ── 1. The nominal mapping ──────────────────────────────────────────────────
--
-- Which QuickBooks account carries which working-paper role, per client. There
-- is no house chart of accounts across 138 client files, so this cannot be a
-- constant and cannot be inferred from an account name — "PAYE" appears as
-- "PAYE Control", "2210 PAYE/NIC", "HMRC — Payroll" and worse.
--
-- MANY accounts to ONE role is allowed and normal: plenty of files split
-- employee tax from employer NIC, or hold CIS suffered in its own nominal
-- alongside the PAYE control. The paper sums them.

create table if not exists public.wp_nominal_map (
  id               bigserial primary key,
  entity_id        uuid not null references public.entities(id) on delete cascade,
  role             text not null check (role in (
                     'paye_control',      -- the PAYE/NIC creditor
                     'cis_suffered',      -- CIS deducted from us, recoverable
                     'cis_withheld',       -- CIS we deducted from subcontractors
                     'net_wages',          -- net pay control / wages payable
                     'wages_control',      -- the clearing account, if used
                     'pension_control',
                     'ct_liability'        -- for the CT paper, next
                   )),
  qbo_account_id   text not null,
  qbo_account_name text,
  -- A liability sits credit in QuickBooks and is reported as a positive amount
  -- owed. Where a file carries a role the other way round (a debit-balance CIS
  -- recoverable, say), -1 puts it on the paper's footing instead of asking the
  -- reviewer to read a sign backwards.
  sign             smallint not null default 1 check (sign in (1, -1)),
  note             text,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (entity_id, role, qbo_account_id)
);

create index if not exists wp_nominal_map_entity_idx on public.wp_nominal_map (entity_id, role);

alter table public.wp_nominal_map enable row level security;

drop policy if exists wp_nominal_map_read on public.wp_nominal_map;
create policy wp_nominal_map_read on public.wp_nominal_map
  for select to authenticated using (public.is_active_staff());

drop policy if exists wp_nominal_map_write on public.wp_nominal_map;
create policy wp_nominal_map_write on public.wp_nominal_map
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- ── 2. The QuickBooks chart, cached ─────────────────────────────────────────
--
-- The mapping UI has to offer a real account list, and the paper has to resolve
-- an account id to a name a reviewer recognises. Pulling the chart live on every
-- render would put a QBO round trip in front of the page for 138 realms.

create table if not exists public.wp_qbo_account (
  realm_id         text not null,
  account_id       text not null,
  name             text,
  fully_qualified  text,
  account_type     text,
  account_sub_type text,
  classification   text,
  active           boolean,
  current_balance  numeric(14,2),
  pulled_at        timestamptz not null default now(),
  primary key (realm_id, account_id)
);

alter table public.wp_qbo_account enable row level security;

drop policy if exists wp_qbo_account_read on public.wp_qbo_account;
create policy wp_qbo_account_read on public.wp_qbo_account
  for select to authenticated using (public.is_active_staff());

drop policy if exists wp_qbo_account_write on public.wp_qbo_account;
create policy wp_qbo_account_write on public.wp_qbo_account
  for all to authenticated
  using (public.is_staff_or_service()) with check (public.is_staff_or_service());

-- Balances as at a date. A working paper is always "as at", never "now" — the
-- whole point is that it still says the same thing when reopened in March.

create table if not exists public.wp_qbo_balance (
  realm_id    text not null,
  account_id  text not null,
  as_at       date not null,
  balance     numeric(14,2) not null,
  pulled_at   timestamptz not null default now(),
  primary key (realm_id, account_id, as_at)
);

alter table public.wp_qbo_balance enable row level security;

drop policy if exists wp_qbo_balance_read on public.wp_qbo_balance;
create policy wp_qbo_balance_read on public.wp_qbo_balance
  for select to authenticated using (public.is_active_staff());

drop policy if exists wp_qbo_balance_write on public.wp_qbo_balance;
create policy wp_qbo_balance_write on public.wp_qbo_balance
  for all to authenticated
  using (public.is_staff_or_service()) with check (public.is_staff_or_service());

-- ── 3. The BrightPay leg ────────────────────────────────────────────────────
--
-- One row per employer per tax period, mirroring BrightPay's HMRC Payments
-- screen. The runner's driver already reads every column here except the three
-- marked below; those need the label added to readLabelled()'s textLabels.
--
-- DELIBERATELY EMPTY on migration. A working paper that shows 0.00 for a leg it
-- has never been fed is worse than one that shows nothing, because 0.00 ties to
-- a nil return and reads as agreement.

create table if not exists public.wp_brightpay_period (
  id             bigserial primary key,
  employer_id    bigint not null,
  entity_id      uuid references public.entities(id) on delete set null,
  tax_year       text not null,           -- '2026-27'
  tax_month      smallint not null check (tax_month between 1 and 12),
  period_kind    text not null default 'month' check (period_kind in ('month','quarter')),

  net_tax          numeric(14,2),
  employee_nic     numeric(14,2),
  employer_nic     numeric(14,2),
  net_nic          numeric(14,2),
  ea_claim         numeric(14,2),
  student_loan     numeric(14,2),         -- not yet read by the driver
  pg_loan          numeric(14,2),         -- not yet read by the driver
  stat_recovered   numeric(14,2),
  stat_nic_comp    numeric(14,2),
  cis_suffered     numeric(14,2),         -- not yet read by the driver
  cis_withheld     numeric(14,2),         -- not yet read by the driver
  amount_due       numeric(14,2),
  amount_paid      numeric(14,2),
  due_previous     numeric(14,2),
  paid_previous    numeric(14,2),
  shortfall        numeric(14,2),
  net_adjustment   numeric(14,2),

  -- The driver cross-checks its own arithmetic before returning a figure
  -- (NIC reconciliation, amount-due reconciliation). Carry that verdict: a
  -- figure the driver could not verify must not silently become evidence.
  reconciles     boolean,
  source         text not null default 'brightpay_hmrc_payments',
  read_at        timestamptz not null default now(),
  unique (employer_id, tax_year, tax_month)
);

create index if not exists wp_brightpay_period_entity_idx
  on public.wp_brightpay_period (entity_id, tax_year, tax_month);

alter table public.wp_brightpay_period enable row level security;

drop policy if exists wp_brightpay_period_read on public.wp_brightpay_period;
create policy wp_brightpay_period_read on public.wp_brightpay_period
  for select to authenticated using (public.is_active_staff());

drop policy if exists wp_brightpay_period_write on public.wp_brightpay_period;
create policy wp_brightpay_period_write on public.wp_brightpay_period
  for all to authenticated
  using (public.is_staff_or_service()) with check (public.is_staff_or_service());

-- ── 4. Sign-off ─────────────────────────────────────────────────────────────
--
-- Who prepared it, who reviewed it, and what was concluded about the variance.
-- A paper with an unexplained variance is not a failure — it is a paper with an
-- open point, and that state has to be recordable or nobody will use this.

create table if not exists public.wp_signoff (
  id            bigserial primary key,
  paper         text not null check (paper in ('paye','corporation_tax','net_wages')),
  entity_id     uuid not null references public.entities(id) on delete cascade,
  period_end    date not null,
  state         text not null default 'open'
                  check (state in ('open','queried','agreed','signed_off')),
  -- The variance as it stood when the conclusion was reached, so a later change
  -- in the underlying data is visible as a change rather than overwriting the
  -- basis somebody signed.
  variance_at_signoff numeric(14,2),
  note          text,
  prepared_by   uuid references auth.users(id),
  prepared_at   timestamptz,
  reviewed_by   uuid references auth.users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (paper, entity_id, period_end)
);

alter table public.wp_signoff enable row level security;

drop policy if exists wp_signoff_read on public.wp_signoff;
create policy wp_signoff_read on public.wp_signoff
  for select to authenticated using (public.is_active_staff());

drop policy if exists wp_signoff_write on public.wp_signoff;
create policy wp_signoff_write on public.wp_signoff
  for all to authenticated
  using (public.is_active_staff()) with check (public.is_active_staff());

-- ── 4a. Grants ──────────────────────────────────────────────────────────────
--
-- Supabase's default privileges hand new public-schema tables to `anon` as well
-- as `authenticated`. RLS would still block a read, but a table reachable with
-- the anon key that ships in the frontend bundle is one policy mistake away from
-- being readable, and these tables carry client nominal codes and payroll
-- figures. Named-role revoke is enough here because the default grants are to
-- named roles, not PUBLIC — checked, not assumed.
revoke all on public.wp_nominal_map, public.wp_qbo_account, public.wp_qbo_balance,
              public.wp_brightpay_period, public.wp_signoff
  from anon, public;

grant select, insert, update, delete
  on public.wp_nominal_map, public.wp_signoff to authenticated;
grant select on public.wp_qbo_account, public.wp_qbo_balance, public.wp_brightpay_period
  to authenticated;
grant select, insert, update, delete
  on public.wp_nominal_map, public.wp_qbo_account, public.wp_qbo_balance,
     public.wp_brightpay_period, public.wp_signoff to service_role;

grant usage, select on sequence public.wp_nominal_map_id_seq,
  public.wp_brightpay_period_id_seq, public.wp_signoff_id_seq
  to authenticated, service_role;

commit;

-- ── 5. The HMRC leg ─────────────────────────────────────────────────────────
--
-- These read the private `hmrc` schema, so they are SECURITY DEFINER by
-- necessity and carry hmrc_can_read() as their own predicate. Removing that
-- predicate exposes 220 clients' tax accounts to every portal user, because
-- portal clients hold `authenticated` alongside staff. It is not optional.

-- Every CIS and Employment Allowance credit line, with the period HMRC recorded
-- it in AND the period its own label says it relates to. This view is the
-- evidence for the timing rules, not a convenience.
drop view if exists public.v_wp_paye_credit_origin;
create view public.v_wp_paye_credit_origin
with (security_invoker = false) as
with scoped as (
  select cl.*
  from hmrc.charge_line cl
  join public.v_hmrc_charge_scope s
    on s.client_id = cl.client_id and s.tax_year = cl.tax_year and s.run_id = cl.run_id
  where cl.kind = 'credit'
),
parsed as (
  select
    c.entity_id,
    c.paye_ref,
    c.name as hmrc_name,
    hmrc.line_category(sc.kind, sc.line_type) as category,
    sc.line_type,
    sc.tax_year  as recorded_tax_year,
    sc.tax_month as recorded_tax_month,
    -- "... for month 7, 2022 to 2023". Where the label carries no period the
    -- relates-to columns stay null rather than defaulting to the recorded one,
    -- so "we don't know" never masquerades as "same month".
    case when sc.line_type ~ 'for month [0-9]+, [0-9]{4} to [0-9]{4}'
         then (regexp_match(sc.line_type, 'for month ([0-9]+), ([0-9]{4}) to [0-9]{4}'))[1]::smallint
    end as relates_tax_month,
    case when sc.line_type ~ 'for month [0-9]+, [0-9]{4} to [0-9]{4}'
         then (regexp_match(sc.line_type, 'for month [0-9]+, ([0-9]{4}) to ([0-9]{4})'))[1]
              || '-' || right(((regexp_match(sc.line_type, 'for month [0-9]+, ([0-9]{4}) to ([0-9]{4})'))[1]::int + 1)::text, 2)
    end as relates_tax_year,
    round(sc.amount::numeric / 100.0, 2) as amount
  from scoped sc
  join hmrc.client c on c.id = sc.client_id
)
select
  p.*,
  -- Named states rather than a boolean, because the three cases mean different
  -- things to a reviewer and only one of them is ever a problem.
  case
    when p.relates_tax_year is null                       then 'unlabelled'
    when p.relates_tax_year <> p.recorded_tax_year        then 'prior_year_credit'
    when p.relates_tax_month <> p.recorded_tax_month      then 'timing_within_year'
    else 'in_period'
  end as timing,
  case when p.relates_tax_month is not null
       then p.recorded_tax_month - p.relates_tax_month end as months_late
from parsed p
where public.hmrc_can_read();

comment on view public.v_wp_paye_credit_origin is
  'Every PAYE credit line (CIS suffered, Employment Allowance) with the tax period HMRC RECORDED it in and the '
  'period its own label says it RELATES TO. The two differ on more than half of CIS lines and occasionally cross '
  'a tax year, so no CIS reconciliation may join on tax_month. timing: in_period | timing_within_year | '
  'prior_year_credit | unlabelled. Amounts in POUNDS. Gated by hmrc_can_read().';

revoke all on public.v_wp_paye_credit_origin from public, anon;
grant select on public.v_wp_paye_credit_origin to authenticated, service_role;
-- The HMRC leg on a tax-year footing: what was charged, what was credited, and
-- what has been paid, split so the CIS offset can be read off directly.
--
-- ── TWO THINGS THE LIVE DATA TAUGHT THIS VIEW ──────────────────────────────
--
-- 1. THE LINE DETAIL HAS ITS OWN RUN SCOPE, PER TAX MONTH.
--
--    Scoping charge_line through v_hmrc_charge_scope — max(run_id) per (client,
--    tax YEAR), taken from hmrc.charge — silently dropped almost every detail
--    line. Detail is not captured on every run: a month's lines may have been
--    scraped on run 40 while the month's totals were refreshed on run 51, and
--    the year-level max matches neither.
--
--    Antonine Builders 2026-27 showed it plainly: charges of 104,917.63 against
--    a detail sum of 2,614.52, and 2025-26 showed 320,183.94 of charges against
--    no detail at all. The correct scope is the one v_hmrc_paye_charge_lines
--    already uses: max(run_id) per (client, tax_year, tax_month), taken from
--    charge_line itself.
--
-- 2. HMRC NEVER ITEMISES CIS WITHHELD, so it has to be derived.
--
--    Checked across the whole of hmrc.charge_line: every CIS line in the table
--    is an EPS CREDIT. 2,083 rows, 80 distinct line types, not one a charge.
--    The FPS section itemises only Income Tax, Employer's NICs, Employees' NI,
--    student/postgraduate loans and the NIC uplift. The CIS a contractor
--    withheld from its subcontractors sits inside the month's charge total and
--    is never broken out — so hmrc.line_category()'s 'CIS withheld' branch is
--    unreachable on this data.
--
--    The residual is therefore not a scrape defect. For a CIS contractor it IS
--    the CIS withheld: Antonine 2024-25, £402,761 charged against £12,293 of
--    itemised payroll, and that £390,468 is CIS deducted from subcontractors.
--    Reporting it as a variance — which the first cut did — would have
--    condemned a perfectly good record on every paper.
--
--      charges_itemised    what the FPS detail adds to
--      charges_unitemised  the rest. Predominantly CIS withheld. For a client
--                          with no CIS it should be nil, and a non-nil value
--                          there IS worth investigating.
--
--    NULL where months_with_detail < months_present, so a part-scraped year
--    never puts a scrape gap into a figure the paper reads as CIS.
drop view if exists public.v_wp_paye_tax_year;
create view public.v_wp_paye_tax_year
with (security_invoker = false) as
with line_scope as (
  select client_id, tax_year, tax_month, max(run_id) as run_id
  from hmrc.charge_line group by client_id, tax_year, tax_month
),
scoped_lines as (
  select cl.* from hmrc.charge_line cl
  join line_scope s on s.client_id = cl.client_id and s.tax_year = cl.tax_year
   and s.tax_month = cl.tax_month and s.run_id = cl.run_id
),
lines as (
  select client_id, tax_year, hmrc.line_category(kind, line_type) as category, kind,
         sum(amount)::numeric / 100.0 as amount
  from scoped_lines group by 1, 2, 3, 4
),
byyear as (
  select client_id, tax_year,
    sum(amount) filter (where category = 'Income tax'           and kind = 'charge') as income_tax,
    sum(amount) filter (where category = 'Employer''s NI'       and kind = 'charge') as employer_ni,
    sum(amount) filter (where category = 'Employees'' NI'       and kind = 'charge') as employee_ni,
    sum(amount) filter (where category = 'Student loan'         and kind = 'charge') as student_loan,
    sum(amount) filter (where category = 'Apprenticeship levy'  and kind = 'charge') as apprenticeship_levy,
    sum(amount) filter (where category = 'Interest'             and kind = 'charge') as interest,
    sum(amount) filter (where category = 'Penalties'            and kind = 'charge') as penalties,
    sum(amount) filter (where category = 'Employment Allowance' and kind = 'credit') as employment_allowance,
    sum(amount) filter (where category = 'CIS suffered'         and kind = 'credit') as cis_suffered,
    sum(amount) filter (where category = 'Statutory payments'   and kind = 'credit') as statutory_recovered,
    sum(amount) filter (where category = 'Other'                and kind = 'charge') as other_charges
  from lines group by 1, 2
),
-- Counted from the LINE rows, not from the grouped `lines` CTE. Counting the
-- latter reported 1 for every client and every year, which on a working paper is
-- not an approximation, it is a wrong number.
cis_lines as (
  select client_id, tax_year, count(*)::int as cis_credit_lines
  from scoped_lines
  where kind = 'credit' and hmrc.line_category(kind, line_type) = 'CIS suffered'
  group by 1, 2
),
detail_cover as (
  select client_id, tax_year, count(distinct tax_month)::int as months_with_detail
  from scoped_lines group by 1, 2
),
-- The charge table is the authority on the year's net position and what has been
-- paid; the lines are the authority on what it is MADE OF.
totals as (
  select ch.client_id, ch.tax_year,
         sum(ch.charges)::numeric / 100.0    as charges_total,
         sum(ch.credits)::numeric / 100.0    as credits_total,
         sum(ch.payments)::numeric / 100.0   as payments_total,
         sum(ch.amount_due)::numeric / 100.0 as amount_due_total,
         count(*)::int                       as months_present,
         bool_and(coalesce(ch.detail_reconciles, false)) as all_months_reconcile
  from hmrc.charge ch
  join public.v_hmrc_charge_scope s
    on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
  group by 1, 2
),
-- CIS credits recorded in this year that belong to an earlier one. These reduce
-- this year's bill and must NOT be expected in this year's payroll — the single
-- most common false variance on a PAYE paper for a CIS subcontractor. Antonine
-- 2025-26: £29,083.82 of a £29,751.82 credit relates to 2024-25.
prior as (
  select client_id, tax_year, sum(amount) as cis_suffered_prior_year
  from (
    select client_id, tax_year, round(amount::numeric / 100.0, 2) as amount,
           (regexp_match(line_type, 'for month [0-9]+, ([0-9]{4}) to [0-9]{4}'))[1] as rel_ys
    from scoped_lines
    where kind = 'credit' and hmrc.line_category(kind, line_type) = 'CIS suffered'
      and line_type ~ 'for month [0-9]+, [0-9]{4} to [0-9]{4}'
  ) x
  where rel_ys is not null and rel_ys || '-' || right((rel_ys::int + 1)::text, 2) <> tax_year
  group by 1, 2
),
shaped as (
  select
    c.entity_id, c.paye_ref, c.name as hmrc_name, t.tax_year, t.client_id,
    -- 6 April to 5 April. Stated, not assumed, because the whole paper turns on it.
    public.hmrc_tax_period_start(t.tax_year, 1)                                       as tax_year_start,
    (public.hmrc_tax_period_start(t.tax_year, 12) + interval '1 month - 1 day')::date as tax_year_end,
    coalesce(b.income_tax, 0) as income_tax, coalesce(b.employee_ni, 0) as employee_ni,
    coalesce(b.employer_ni, 0) as employer_ni, coalesce(b.student_loan, 0) as student_loan,
    coalesce(b.apprenticeship_levy, 0) as apprenticeship_levy,
    coalesce(b.interest, 0) as interest, coalesce(b.penalties, 0) as penalties,
    coalesce(b.other_charges, 0) as other_charges,
    coalesce(b.employment_allowance, 0) as employment_allowance,
    coalesce(b.cis_suffered, 0) as cis_suffered,
    coalesce(cl.cis_credit_lines, 0) as cis_credit_lines,
    coalesce(b.statutory_recovered, 0) as statutory_recovered,
    coalesce(p.cis_suffered_prior_year, 0) as cis_suffered_prior_year,
    coalesce(b.cis_suffered, 0) - coalesce(p.cis_suffered_prior_year, 0) as cis_suffered_in_year,
    t.charges_total, t.credits_total, t.payments_total, t.amount_due_total,
    t.charges_total - t.credits_total - t.payments_total as balance_per_hmrc,
    t.months_present, coalesce(d.months_with_detail, 0) as months_with_detail,
    t.all_months_reconcile
  from totals t
  join hmrc.client c on c.id = t.client_id
  left join byyear b       on b.client_id = t.client_id and b.tax_year = t.tax_year
  left join cis_lines cl   on cl.client_id = t.client_id and cl.tax_year = t.tax_year
  left join detail_cover d on d.client_id = t.client_id and d.tax_year = t.tax_year
  left join prior p        on p.client_id = t.client_id and p.tax_year = t.tax_year
)
select s.*,
  round(s.income_tax + s.employee_ni + s.employer_ni + s.student_loan
        + s.apprenticeship_levy + s.interest + s.penalties + s.other_charges, 2) as charges_itemised,
  case when s.months_with_detail = s.months_present then
    round(s.charges_total - (s.income_tax + s.employee_ni + s.employer_ni + s.student_loan
             + s.apprenticeship_levy + s.interest + s.penalties + s.other_charges), 2)
  end as charges_unitemised
from shaped s
-- STATED HERE, not inherited from a joined view.
--
-- An earlier revision moved the body into CTEs and lost this line. It still
-- tested closed, because the `totals` CTE joins v_hmrc_charge_scope which
-- carries the gate internally — which is precisely the shape CLAUDE.md warns
-- about: a definer view over the private schema whose access control lives
-- somewhere else, one refactor away from open and invisible to a reviewer
-- reading this file.
where public.hmrc_can_read();

comment on view public.v_wp_paye_tax_year is
  'PAYE per client per TAX YEAR (6 Apr - 5 Apr) for the PAYE working paper. Line detail is scoped per (client, '
  'tax_year, tax_month) from charge_line itself, because detail is not captured on every scrape run. HMRC never '
  'itemises CIS withheld - every CIS line in the source is an EPS credit - so charges_unitemised (charges_total '
  'less charges_itemised) is the derived CIS withheld for a contractor, and should be nil for a client with no '
  'CIS. NULL where months_with_detail < months_present, so a scrape gap is never read as CIS. '
  'cis_suffered_prior_year is the part of this year''s CIS credit relating to an earlier tax year, which has no '
  'counterpart in this year''s payroll. Amounts in POUNDS. Gated by hmrc_can_read().';

revoke all on public.v_wp_paye_tax_year from public, anon;
grant select on public.v_wp_paye_tax_year to authenticated, service_role;

-- ── 6. The QuickBooks leg, resolved through the mapping ─────────────────────
--
-- security_invoker so wp_nominal_map's and wp_qbo_balance's own policies apply.
drop view if exists public.v_wp_qbo_role_balance;
create view public.v_wp_qbo_role_balance
with (security_invoker = true) as
select
  m.entity_id,
  rc.realm_id,
  m.role,
  bal.as_at,
  sum(bal.balance * m.sign)             as balance,
  count(*)::int                         as accounts_matched,
  min(bal.pulled_at)                    as pulled_at,
  string_agg(coalesce(m.qbo_account_name, a.name, m.qbo_account_id), ', '
             order by coalesce(m.qbo_account_name, a.name, m.qbo_account_id)) as accounts
from public.wp_nominal_map m
join public.qbo_report_connections rc
  on rc.entity_id = m.entity_id and rc.status = 'active'
join public.wp_qbo_balance bal
  on bal.realm_id = rc.realm_id and bal.account_id = m.qbo_account_id
left join public.wp_qbo_account a
  on a.realm_id = rc.realm_id and a.account_id = m.qbo_account_id
group by m.entity_id, rc.realm_id, m.role, bal.as_at;

comment on view public.v_wp_qbo_role_balance is
  'A client''s QuickBooks balance for each working-paper role at a date, summed across every nominal mapped to '
  'that role and signed onto the paper''s footing. accounts_matched < the number of mapped accounts means a '
  'balance has not been pulled for one of them at this date.';

revoke all on public.v_wp_qbo_role_balance from public, anon;
grant select on public.v_wp_qbo_role_balance to authenticated, service_role;

-- ── 7. Mapping coverage ─────────────────────────────────────────────────────
--
-- Which clients can have a PAYE paper prepared at all, and what is stopping the
-- rest. Answering "why is this client not on the list" is the first question
-- anyone will ask, so it is a view rather than something the frontend infers
-- from an empty result.
--
-- ONE ROW PER CLIENT, ALWAYS. The first cut left-joined qbo_report_connections
-- and the BrightPay link directly, and AATT Ltd came back twice: it has TWO
-- active QuickBooks connections against one entity. On a working-paper list a
-- duplicated client is not cosmetic — it is the same paper offered twice with a
-- different ledger behind each, and picking one arbitrarily would hide the fact
-- that nobody has decided which file is the real one. So both sides are
-- aggregated and the COUNT is exposed.
--
-- Measured on the live data, 19 Aug 2026: 603 active clients, of which 443 have
-- no PAYE reference (no payroll — correctly out of scope), 52 have no QuickBooks
-- connection, 1 is ambiguous, and 107 need nothing but the nominal mapping.
-- That 107 is the population this module is for.
drop view if exists public.v_wp_paye_readiness;
create view public.v_wp_paye_readiness
with (security_invoker = true) as
with qbo as (
  select entity_id,
         count(*)::int as connections,
         (array_agg(realm_id order by connected_at))[1]      as realm_id,
         (array_agg(company_name order by connected_at))[1]  as company_name,
         array_agg(realm_id order by connected_at)           as realm_ids
  from public.qbo_report_connections
  where status = 'active' and entity_id is not null
  group by entity_id
),
-- Through the public gated view, not hmrc.brightpay_link directly: this view is
-- security_invoker, and `authenticated` has no grant inside the hmrc schema.
bp as (
  select entity_id,
         count(*)::int as employers,
         (array_agg(employer_id order by employer_id))[1]     as employer_id,
         (array_agg(brightpay_name order by employer_id))[1]  as brightpay_name
  from public.v_hmrc_paye_brightpay_link
  where entity_id is not null
  group by entity_id
),
nm as (
  select entity_id,
         count(*) filter (where role = 'paye_control') as paye_accounts,
         count(*) filter (where role in ('cis_suffered','cis_withheld')) as cis_accounts
  from public.wp_nominal_map group by entity_id
),
held as (
  select entity_id, count(*) as periods, max(tax_year) as latest_tax_year
  from public.wp_brightpay_period where entity_id is not null group by entity_id
)
select
  e.id                              as entity_id,
  e.name                            as entity_name,
  e.paye_ref,
  q.realm_id,
  q.company_name                    as qbo_company,
  coalesce(q.connections, 0)        as qbo_connections,
  q.realm_ids,
  b.employer_id                     as brightpay_employer_id,
  b.brightpay_name                  as brightpay_employer,
  coalesce(b.employers, 0)          as brightpay_employers,
  (e.paye_ref is not null)          as has_paye_ref,
  (q.realm_id is not null)          as has_qbo,
  (b.employer_id is not null)       as has_brightpay,
  coalesce(nm.paye_accounts, 0)     as paye_accounts_mapped,
  coalesce(nm.cis_accounts, 0)      as cis_accounts_mapped,
  coalesce(h.periods, 0)            as brightpay_periods_held,
  h.latest_tax_year                 as brightpay_latest_tax_year,
  -- What is stopping a paper being prepared, in the order it has to be fixed.
  case
    when e.paye_ref is null              then 'no_paye_ref'
    when q.realm_id is null              then 'no_qbo_connection'
    when coalesce(q.connections,0) > 1   then 'ambiguous_qbo_connection'
    when coalesce(nm.paye_accounts,0)= 0 then 'no_nominal_mapping'
    when b.employer_id is null           then 'no_brightpay_link'
    when coalesce(h.periods,0) = 0       then 'no_brightpay_periods'
    else 'ready'
  end as blocker
from public.entities e
left join qbo q  on q.entity_id  = e.id
left join bp  b  on b.entity_id  = e.id
left join nm     on nm.entity_id = e.id
left join held h on h.entity_id  = e.id
where e.entity_status = 'active';

comment on view public.v_wp_paye_readiness is
  'One row per active client: which of the three PAYE legs is available, and `blocker` — the first thing stopping '
  'a paper being prepared, in fix order. qbo_connections > 1 means two QuickBooks files are linked to one client '
  'and nobody has decided which is the ledger; the paper refuses rather than guessing.';

revoke all on public.v_wp_paye_readiness from public, anon;
grant select on public.v_wp_paye_readiness to authenticated, service_role;
