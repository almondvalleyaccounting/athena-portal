-- 205 — Scope hmrc.charge per TAX YEAR, not per run.
--
-- sql/198 fixed double counting by scoping every child table to the run that
-- produced the client's latest position. Correct for overdue_item, payment and
-- credit — each is written complete on every run (316 / 508 / 287 rows, run
-- after run).
--
-- hmrc.charge is not. Its depth varies with how the run was invoked:
--
--   run 1   423 rows    1 tax year   (2026-27)
--   run 2   10,575 rows 7 tax years  (2020-21 .. 2026-27)
--   run 3   423 rows    1 tax year   (2026-27)
--
-- So "latest run" threw away six years of history the moment run 3 landed. The
-- Trend tab dropped from 75 months to 3, and Balance analysis with it. Nothing
-- was double counted — it was silently truncated instead, which is the same
-- class of failure in the opposite direction.
--
-- The rule that holds whatever the next run does: for each client and tax year,
-- take the most recent run that actually carried charge rows for that year.
-- Freshest observation per year, and a narrow run can never erase a wide one.
-- Mixing runs across years is deliberate and safe — HMRC's 2020-21 figures do
-- not change because we re-read 2026-27.
--
-- Applies to v_hmrc_paye_months and v_hmrc_paye_month_trend (mine) and
-- v_hmrc_paye_balance (the parallel session's) — all three read hmrc.charge and
-- all three lost the same six years. charge_line gets the same treatment at
-- month grain; only run 3 carries it today, so max(run_id) is a no-op now but
-- will not truncate later.

-- ── the shared scope rule, as one definition ───────────────────────
create or replace view public.v_hmrc_charge_scope as
select client_id, tax_year, max(run_id) as run_id
from hmrc.charge
group by client_id, tax_year;

comment on view public.v_hmrc_charge_scope is
  'For each client and tax year, the most recent scrape that carried charge rows for it. THE scoping rule for hmrc.charge — run depth varies, so a plain latest-run join silently drops tax years. Internal: not granted to authenticated.';

-- Internal plumbing for the definer views below; nothing reads it directly.
revoke all on public.v_hmrc_charge_scope from public, anon, authenticated;

-- ── v_hmrc_paye_months ─────────────────────────────────────────────
create or replace view public.v_hmrc_paye_months as
select
  ch.id,
  c.paye_ref,
  c.entity_id,
  ch.tax_year,
  ch.tax_month,
  ch.label,
  round(ch.charges    / 100.0, 2)               as charges,
  round(ch.credits    / 100.0, 2)               as credits,
  round(ch.payments   / 100.0, 2)               as payments,
  round(ch.net_charge / 100.0, 2)               as net_charge,
  round(ch.amount_due / 100.0, 2)               as amount_due,
  ch.overdue
from hmrc.charge ch
join public.v_hmrc_charge_scope s
  on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
join hmrc.client c on c.id = ch.client_id
where public.hmrc_can_read();

-- ── v_hmrc_paye_balance (parallel session's; scope rule only) ───────
create or replace view public.v_hmrc_paye_balance as
with per_year as (
  select
    c.paye_ref,
    c.entity_id,
    c.name as hmrc_name,
    ch.tax_year,
    sum(ch.charges)                                        as charges,
    sum(ch.credits)                                        as credits,
    sum(ch.payments)                                       as payments,
    sum(ch.amount_due)                                     as still_due,
    count(*) filter (where ch.overdue)                     as overdue_months,
    count(*) filter (where ch.charges > 0)                 as charged_months,
    bool_and(coalesce(ch.detail_reconciles, true))          as detail_reconciles,
    count(*) filter (where ch.detail_reconciles is not null) as months_with_detail
  from hmrc.charge ch
  join public.v_hmrc_charge_scope s
    on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
  join hmrc.client c on c.id = ch.client_id
  group by c.paye_ref, c.entity_id, c.name, ch.tax_year
)
select
  paye_ref,
  entity_id,
  hmrc_name,
  tax_year,
  round(charges / 100.0, 2)              as charges,
  round(credits / 100.0, 2)              as credits,
  round((charges - credits) / 100.0, 2)  as net_charged,
  round(payments / 100.0, 2)             as payments,
  round(still_due / 100.0, 2)            as still_due,
  round(sum(still_due) over (partition by paye_ref order by tax_year
        rows between unbounded preceding and current row) / 100.0, 2) as cumulative_due,
  round((sum(still_due) over (partition by paye_ref order by tax_year
        rows between unbounded preceding and current row) - still_due) / 100.0, 2) as brought_forward,
  overdue_months,
  charged_months,
  detail_reconciles,
  months_with_detail
from per_year
where public.hmrc_can_read();

-- ── v_hmrc_paye_charge_lines (same rule, month grain) ──────────────
create or replace view public.v_hmrc_paye_charge_lines as
with line_scope as (
  select client_id, tax_year, tax_month, max(run_id) as run_id
  from hmrc.charge_line
  group by client_id, tax_year, tax_month
)
select
  cl.id,
  c.paye_ref,
  c.entity_id,
  cl.tax_year,
  cl.tax_month,
  cl.section,
  cl.kind,
  cl.line_type,
  hmrc.line_category(cl.kind, cl.line_type) as category,
  round(cl.amount::numeric / 100.0, 2)      as amount
from hmrc.charge_line cl
join line_scope s
  on s.client_id = cl.client_id and s.tax_year = cl.tax_year
 and s.tax_month = cl.tax_month and s.run_id = cl.run_id
join hmrc.client c on c.id = cl.client_id
where public.hmrc_can_read();

-- ── v_hmrc_paye_month_trend ────────────────────────────────────────
create or replace view public.v_hmrc_paye_month_trend as
with bp as (
  select
    t.employer_id,
    (case
       when extract(month from t.period_end) > 4
         or (extract(month from t.period_end) = 4 and extract(day from t.period_end) >= 6)
       then extract(year from t.period_end)::int
       else extract(year from t.period_end)::int - 1
     end)                                                             as ty_start,
    ((extract(month from t.period_end)::int - 4 + 12) % 12)
      + case when extract(day from t.period_end) >= 6 then 1 else 0 end as tax_month,
    t.amount                                                          as bp_liability,
    coalesce(t.ea_amount, 0)                                          as bp_ea,
    greatest(1, round((t.period_end - t.period_start) / 30.0)::int)    as bp_months_covered,
    t.state                                                           as bp_state
  from payroll.task t
  where t.kind = 'hmrc' and t.amount is not null
),
bp_keyed as (
  select
    b.employer_id,
    b.ty_start || '-' || right((b.ty_start + 1)::text, 2) as tax_year,
    case when b.tax_month = 0 then 12 else b.tax_month end as tax_month,
    b.bp_liability, b.bp_ea, b.bp_months_covered, b.bp_state
  from bp b
),
m as (
  select
    c.paye_ref, c.entity_id, c.name as hmrc_name,
    ch.tax_year, ch.tax_month,
    ch.charges, ch.credits, ch.payments, ch.amount_due
  from hmrc.charge ch
  join public.v_hmrc_charge_scope s
    on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
  join hmrc.client c on c.id = ch.client_id
)
select
  m.paye_ref,
  m.entity_id,
  m.hmrc_name,
  m.tax_year,
  m.tax_month,
  round(m.charges    / 100.0, 2)                        as charges,
  round(m.credits    / 100.0, 2)                        as credits,
  round((m.charges - m.credits) / 100.0, 2)             as net_charged,
  round(m.payments   / 100.0, 2)                        as payments,
  round(m.amount_due / 100.0, 2)                        as still_due,
  round(sum(m.amount_due) over (
    partition by m.paye_ref order by m.tax_year, m.tax_month
    rows between unbounded preceding and current row) / 100.0, 2)     as cumulative_due,
  round((sum(m.amount_due) over (
    partition by m.paye_ref order by m.tax_year, m.tax_month
    rows between unbounded preceding and current row) - m.amount_due) / 100.0, 2) as brought_forward,
  bk.bp_liability,
  bk.bp_ea,
  bk.bp_months_covered,
  bk.bp_state,
  (bk.bp_liability is not null)                         as brightpay_covered,
  case when bk.bp_liability is not null
       then round(bk.bp_liability - m.charges / 100.0, 2) end          as variance_gross,
  case when bk.bp_liability is not null
       then round((bk.bp_liability - bk.bp_ea) - (m.charges - m.credits) / 100.0, 2) end as variance_net,
  cl.entity_name,
  cl.standing,
  cl.chase_tier,
  e.manager
from m
left join public.v_hmrc_paye_brightpay_link lk on lk.paye_ref = m.paye_ref
left join bp_keyed bk
       on bk.employer_id = lk.employer_id
      and bk.tax_year    = m.tax_year
      and bk.tax_month   = m.tax_month
left join public.v_hmrc_paye_clients cl on cl.paye_ref = m.paye_ref
left join public.entities e             on e.id = m.entity_id
where public.hmrc_can_read();

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_months', 'v_hmrc_paye_balance', 'v_hmrc_paye_charge_lines',
    'v_hmrc_paye_month_trend'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
