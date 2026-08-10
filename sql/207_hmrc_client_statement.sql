-- 207 — A client-level PAYE statement, and active clients only.
--
-- Bobby, on seeing the aggregate trend: the report is meant to be per client,
-- months down the side, and opening / charges / credits / payments / closing
-- across the top with charges and credits broken out to their components. Plus
-- real dates to filter on, because a year end is rarely 5 April and the whole
-- point is producing the PAYE creditor for a set of accounts.
--
-- The detail is now possible: hmrc.charge_line covers all seven tax years (it
-- was 3 months when the Trend tab was built) and its categories are a short,
-- fixed list, so the pivot belongs in SQL rather than the browser:
--
--   charges   Income tax · Employer's NI · Employees' NI · Student loan · Interest
--   credits   Employment Allowance · CIS suffered · Statutory payments
--
-- PERIOD DATES. Tax month N of a year starting Y runs from 6 Apr + (N-1) months
-- to the 5th of the following month. Deriving real dates is what lets a period
-- filter cross a tax-year boundary — 1 Oct to 30 Sep spans two of them.
--
-- WHICH FIGURE IS AUTHORITATIVE. charges/credits come from hmrc.charge; the
-- category columns come from hmrc.charge_line and are its breakdown. They can
-- disagree, so charge.detail_reconciles is carried through as
-- `detail_reconciles` and the totals shown are always hmrc.charge's. The
-- breakdown explains the total; it never replaces it.
--
-- ACTIVE CLIENTS ONLY. Former and archived clients are excluded at read time
-- from the operational surfaces, per the rule that already governs every other
-- one (sql/134). They stay visible in the authorisations list, which exists
-- precisely to deal with them.

-- ── period dates on the month grain ────────────────────────────────
create or replace function public.hmrc_tax_period_start(p_tax_year text, p_tax_month int)
returns date
language sql
immutable
as $$
  select make_date(split_part(p_tax_year, '-', 1)::int, 4, 6)
       + ((p_tax_month - 1) * interval '1 month');
$$;

comment on function public.hmrc_tax_period_start(text, int) is
  'First day of a PAYE tax month: 6 Apr of the tax year, plus whole months. Month 1 of 2026-27 = 2026-04-06.';

grant execute on function public.hmrc_tax_period_start(text, int) to authenticated, service_role;

-- ── the statement ──────────────────────────────────────────────────
create or replace view public.v_hmrc_paye_client_statement as
with scoped as (
  select ch.*
  from hmrc.charge ch
  join public.v_hmrc_charge_scope s
    on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
),
lines as (
  select
    cl.client_id,
    cl.tax_year,
    cl.tax_month,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Income tax')            as l_income_tax,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Employer''s NI')        as l_employer_ni,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Employees'' NI')        as l_employees_ni,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Student loan')          as l_student_loan,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Interest')              as l_interest,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Employment Allowance')  as l_ea,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'CIS suffered')          as l_cis,
    sum(cl.amount) filter (where hmrc.line_category(cl.kind, cl.line_type) = 'Statutory payments')    as l_statutory,
    count(*)                                                                                          as line_count
  from hmrc.charge_line cl
  join (
    select client_id, tax_year, tax_month, max(run_id) as run_id
    from hmrc.charge_line group by client_id, tax_year, tax_month
  ) ls on ls.client_id = cl.client_id and ls.tax_year = cl.tax_year
      and ls.tax_month = cl.tax_month and ls.run_id = cl.run_id
  group by cl.client_id, cl.tax_year, cl.tax_month
)
select
  c.paye_ref,
  c.entity_id,
  coalesce(c.entity_name, e.name)                       as entity_name,
  c.name                                                as hmrc_name,
  s.tax_year,
  s.tax_month,
  public.hmrc_tax_period_start(s.tax_year, s.tax_month) as period_start,
  (public.hmrc_tax_period_start(s.tax_year, s.tax_month) + interval '1 month - 1 day')::date
                                                        as period_end,
  -- The 22nd after the period ends is HMRC's electronic payment deadline.
  (public.hmrc_tax_period_start(s.tax_year, s.tax_month) + interval '1 month 16 days')::date
                                                        as due_date,

  -- Opening / closing: the running residue of everything charged and not paid.
  round((sum(s.amount_due) over w - s.amount_due) / 100.0, 2) as opening,
  round(s.charges    / 100.0, 2)                        as charges,
  round(s.credits    / 100.0, 2)                        as credits,
  round(s.payments   / 100.0, 2)                        as payments,
  round(s.amount_due / 100.0, 2)                        as movement,
  round(sum(s.amount_due) over w / 100.0, 2)            as closing,

  -- Charge detail
  round(coalesce(l.l_income_tax, 0)   / 100.0, 2)       as charge_income_tax,
  round(coalesce(l.l_employer_ni, 0)  / 100.0, 2)       as charge_employer_ni,
  round(coalesce(l.l_employees_ni, 0) / 100.0, 2)       as charge_employees_ni,
  round(coalesce(l.l_student_loan, 0) / 100.0, 2)       as charge_student_loan,
  round(coalesce(l.l_interest, 0)     / 100.0, 2)       as charge_interest,

  -- Credit detail
  round(coalesce(l.l_ea, 0)        / 100.0, 2)          as credit_employment_allowance,
  round(coalesce(l.l_cis, 0)       / 100.0, 2)          as credit_cis_suffered,
  round(coalesce(l.l_statutory, 0) / 100.0, 2)          as credit_statutory_payments,

  coalesce(l.line_count, 0)                             as detail_lines,
  s.detail_reconciles,
  s.overdue,
  s.label
from scoped s
join hmrc.client c        on c.id = s.client_id
join public.entities e    on e.id = c.entity_id
left join lines l         on l.client_id = s.client_id
                         and l.tax_year  = s.tax_year
                         and l.tax_month = s.tax_month
where public.hmrc_can_read()
  -- Active clients only. Former / archived / not-in-Athena are noise here; the
  -- authorisations list is where they get dealt with.
  and e.entity_status::text = 'active'
window w as (
  partition by c.paye_ref order by s.tax_year, s.tax_month
  rows between unbounded preceding and current row
);

comment on view public.v_hmrc_paye_client_statement is
  'Per client per tax MONTH: opening + charges - credits - payments = closing, with charges and credits '
  'broken to their HMRC categories, and real period_start / period_end / due_date so a filter can cross '
  'tax years. Totals come from hmrc.charge; the category columns are its breakdown and detail_reconciles '
  'says whether they tie. Active clients only. Amounts in POUNDS.';

-- ── payments, with their allocation ────────────────────────────────
-- Its own surface now: a payments tab, and the clickable detail behind a
-- payments figure on the statement.
create or replace view public.v_hmrc_paye_payment_detail as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc."position"
  order by client_id, scraped_at desc
)
select
  p.id,
  c.paye_ref,
  c.entity_id,
  coalesce(c.entity_name, e.name)               as entity_name,
  p.tax_year                                    as received_tax_year,
  p.received_on                                 as received_on_text,
  public.hmrc_safe_date(p.received_on)          as received_on,
  -- HMRC signals "not applied" two ways: an empty allocation, or the literal
  -- string 'UNALLOCATED'. Normalise both to null so the flag below is the single
  -- source of truth and the column never shows a non-allocation as one.
  case when upper(trim(coalesce(p.allocated_to, ''))) in ('', 'UNALLOCATED')
       then null else p.allocated_to end        as allocated_to,
  p.allocated_year,
  p.allocated_month,
  case
    when p.allocated_year is not null and p.allocated_month is not null
    then public.hmrc_tax_period_start(p.allocated_year, p.allocated_month)
  end                                           as allocated_period_start,
  (upper(trim(coalesce(p.allocated_to, ''))) in ('', 'UNALLOCATED')) as unallocated,
  round(p.amount / 100.0, 2)                    as amount
from hmrc.payment p
join hmrc.client c     on c.id = p.client_id
join public.entities e on e.id = c.entity_id
join latest l          on l.client_id = p.client_id and l.run_id = p.run_id
where public.hmrc_can_read()
  and e.entity_status::text = 'active'
  and coalesce(p.received_on, '') <> 'Total payment amount';

comment on view public.v_hmrc_paye_payment_detail is
  'Every payment HMRC has recorded, when it arrived and which tax month it was allocated against. '
  'unallocated flags money sitting on the scheme reducing nothing. Active clients only. Amounts in POUNDS.';

-- ── active clients only on the operational lists ───────────────────
create or replace view public.v_hmrc_paye_clients as
with latest as (
  select distinct on (p.client_id) p.*
  from hmrc."position" p
  order by p.client_id, p.scraped_at desc
),
od as (
  select
    o.client_id,
    count(*)                                                          as overdue_items,
    count(*) filter (where o.section = 'monthly')                     as overdue_monthly_items,
    count(*) filter (where o.section = 'additional')                  as overdue_additional_items,
    count(*) filter (where o.charge_type = 'Penalty')                 as penalty_items,
    min(public.hmrc_safe_date(o.due_date))                            as oldest_due_date,
    min(o.tax_year)                                                   as oldest_overdue_year,
    round(sum(o.interest)             / 100.0, 2)                     as overdue_interest,
    round(sum(o.amount_due) filter (where o.charge_type = 'Penalty')
                                      / 100.0, 2)                     as penalties
  from hmrc.overdue_item o
  join latest l on l.client_id = o.client_id and l.run_id = o.run_id
  group by o.client_id
)
select
  c.id                                          as hmrc_client_id,
  c.paye_ref,
  c.district,
  c.reference,
  c.name                                        as hmrc_name,
  c.your_reference,
  c.accounts_office_ref,
  c.entity_id,
  coalesce(c.entity_name, e.name)               as entity_name,
  c.link_method,
  e.entity_status::text                         as athena_status,
  'client'::text                                as standing,
  l.tax_year,
  round(l.total_debt          / 100.0, 2)       as total_debt,
  round(l.overdue_monthly     / 100.0, 2)       as overdue_monthly,
  round(l.overdue_additional  / 100.0, 2)       as overdue_additional,
  round(l.accruing_interest   / 100.0, 2)       as accruing_interest,
  round(l.amount_due_year     / 100.0, 2)       as amount_due_year,
  round(l.charges             / 100.0, 2)       as charges,
  round(l.credits             / 100.0, 2)       as credits,
  round(l.payments            / 100.0, 2)       as payments,
  l.payment_plan,
  l.variable_dd,
  l.claiming_ea,
  l.scraped_at,
  l.run_id                                      as scrape_run_id,
  coalesce(od.overdue_items, 0)                 as overdue_items,
  coalesce(od.overdue_monthly_items, 0)         as overdue_monthly_items,
  coalesce(od.overdue_additional_items, 0)      as overdue_additional_items,
  coalesce(od.penalty_items, 0)                 as penalty_items,
  coalesce(od.penalties, 0)                     as penalties,
  coalesce(od.overdue_interest, 0)              as overdue_interest,
  od.oldest_due_date,
  od.oldest_overdue_year,
  case when od.oldest_due_date is not null
       then (current_date - od.oldest_due_date) end as days_oldest_overdue,
  case
    when coalesce(l.total_debt, 0) <= 0                                     then 4
    when l.payment_plan is true                                             then 3
    when od.oldest_overdue_year is not null
     and od.oldest_overdue_year < l.tax_year                                then 1
    else 2
  end                                           as chase_tier,
  coalesce(r.status, 'pending')                 as review_status,
  r.notes                                       as review_notes,
  r.reviewed_at                                 as review_reviewed_at
from hmrc.client c
join public.entities e       on e.id = c.entity_id
left join latest l           on l.client_id = c.id
left join od                 on od.client_id = c.id
left join public.hmrc_debt_reviews r on r.paye_ref = c.paye_ref
where public.hmrc_can_read()
  and e.entity_status::text = 'active';

comment on view public.v_hmrc_paye_clients is
  'One row per PAYE scheme of an ACTIVE client, as at its latest scrape. Former, archived and '
  'not-in-Athena schemes are excluded at read time — they are noise on an operational list and belong '
  'on the authorisations tab. Amounts in POUNDS.';

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_client_statement', 'v_hmrc_paye_payment_detail', 'v_hmrc_paye_clients'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
