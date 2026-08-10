-- 209 — Settle the BrightPay comparison basis, and add the variance column.
--
-- sql/203 built the BrightPay link but could not choose between two possible
-- comparisons because the two sources did not yet overlap. 2026-27 month 4
-- (HMRC posted it on 10 Aug) is the first month they do, and it settles it.
--
-- BrightPay's payroll.task.amount is NET of Employment Allowance. On 10 of the
-- 38 comparable schemes it equals HMRC's charges - credits exactly, and on those
-- same schemes task.ea_amount equals HMRC's credits to the penny:
--
--   Domain Design Agency   bp 1,558.82  charges 2,874.92  credits 1,316.10
--   Flat Flat White        bp   971.64  charges 2,038.92  credits 1,067.28
--   Clarkson Owens         bp 1,347.69  charges 2,378.79  credits 1,031.10
--   Osiris Educational     bp   576.26  charges   979.66  credits   403.40
--
-- Neither existing column measures that. variance_gross compares BrightPay's net
-- against HMRC's gross; variance_net deducts EA a second time from a figure that
-- already has it out. Both are wrong on the same basis, which is why offering two
-- and choosing neither was the honest thing at the time. `variance` is the one to
-- use. The old columns stay only because hmrc_trend_monthly() and
-- v_hmrc_paye_trend_monthly read them.
--
-- STILL OPEN — do not read a non-zero variance as an error yet. Of 38 schemes:
--   10  equal month 4 alone
--   13  equal month 3 + month 4 combined
--   11  equal neither
-- Every BrightPay task carries period 2026-07-06 to 2026-08-05, which IS tax
-- month 4, so the 13 spanning two months are not a mapping fault on this side —
-- the runner's rule for what an 'hmrc' task covers needs confirming by whoever
-- owns it. Of the remaining 11, some are small residuals (Monument -£84,
-- Puddleduck -£10.56, plausibly interest) and some are schemes where HMRC has
-- charged nothing at all while BrightPay reports a liability (McManus £364.88,
-- Klm CNC £283.71) — a real finding, and the sort of thing the triangulation
-- exists to surface.

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
  round(sum(m.amount_due) over w / 100.0, 2)            as cumulative_due,
  round((sum(m.amount_due) over w - m.amount_due) / 100.0, 2) as brought_forward,
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
  e.manager,
  -- THE variance. BrightPay's liability is net of EA, so it compares against
  -- HMRC's charges less credits. Zero = the two sources agree.
  case when bk.bp_liability is not null
       then round(bk.bp_liability - (m.charges - m.credits) / 100.0, 2) end as variance
from m
left join public.v_hmrc_paye_brightpay_link lk on lk.paye_ref = m.paye_ref
left join bp_keyed bk
       on bk.employer_id = lk.employer_id
      and bk.tax_year    = m.tax_year
      and bk.tax_month   = m.tax_month
left join public.v_hmrc_paye_clients cl on cl.paye_ref = m.paye_ref
left join public.entities e             on e.id = m.entity_id
where public.hmrc_can_read()
window w as (
  partition by m.paye_ref order by m.tax_year, m.tax_month
  rows between unbounded preceding and current row
);

comment on view public.v_hmrc_paye_month_trend is
  'Per scheme per tax MONTH, with BrightPay''s stated liability alongside HMRC''s charge. Use the `variance` '
  'column: BrightPay''s amount is NET of Employment Allowance (proven on 2026-27 month 4 — see sql/209), so '
  'it compares against charges - credits. variance_gross and variance_net are on the wrong basis and are '
  'retained only for the older trend rollups. Amounts in POUNDS.';

revoke all on public.v_hmrc_paye_month_trend from public, anon;
grant select on public.v_hmrc_paye_month_trend to authenticated, service_role;
