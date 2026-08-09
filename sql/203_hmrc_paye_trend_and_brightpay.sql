-- 203 — PAYE trend at three grains, and the BrightPay link for reconciling it.
--
-- Bobby wants to aggregate by month, by tax year and in total, reconciling the
-- current year against BrightPay and carrying everything older as an opening
-- balance rather than trying to re-reconcile seven years of history.
--
-- That shape falls straight out of the data:
--
--   v_hmrc_paye_brightpay_link   who in BrightPay is which PAYE scheme
--   v_hmrc_paye_month_trend      per scheme per tax MONTH — the finest grain,
--                                with a running balance and BrightPay alongside
--   v_hmrc_paye_trend_monthly    the same rolled up practice-wide, ~84 rows, so
--                                month / year / total are all cheap rollups of
--                                one small result set in the browser
--
-- WHY MONTH IS THE BASE GRAIN: v_hmrc_paye_balance (the parallel session's view)
-- already does per-scheme per-YEAR and is the definition for that. This goes one
-- level finer because BrightPay states a liability per tax month, and a monthly
-- variance is the thing you can actually act on. The two agree by construction —
-- both sum hmrc.charge scoped to the latest run.
--
-- OPENING BALANCE: reconciliation starts where BrightPay's records start. Every
-- month carries `brightpay_covered` so the UI can draw that line and present
-- everything before it as a single brought-forward figure — the historic
-- balancing adjustment — instead of pretending it was verified.
--
-- PAYROLL EXPOSURE: sql/192 deliberately kept the `payroll` schema off the API
-- and handed out narrow definer functions instead. These views keep to that
-- spirit — they expose employer name, period and the two liability figures, and
-- nothing else of the runner's state — and carry the same hmrc_can_read() guard
-- as the rest of the module.

-- ── BrightPay employer → Athena entity → PAYE scheme ───────────────
-- destination_realm is null for most active employers, so the link is a
-- normalised-name match: lowercase, drop the legal suffix, drop punctuation.
-- Same normalisation as the v_hmrc_link_exceptions suggestion. 96 of 106 active
-- employers match an entity and 91 carry through to a scheme; the remainder show
-- here with a null scheme so they are visible rather than silently dropped.
create or replace view public.v_hmrc_paye_brightpay_link as
with norm_e as (
  select
    id, name, entity_status,
    regexp_replace(
      regexp_replace(lower(name), '\s+(limited|ltd|llp|plc)\.?$', ''),
      '[^a-z0-9]', '', 'g') as k
  from public.entities
)
select
  p.id                      as employer_id,
  p.brightpay_name,
  p.sheet_name,
  p.active,
  p.ea_applicable,
  p.destination_realm,
  e.id                      as entity_id,
  e.name                    as entity_name,
  e.entity_status::text     as entity_status,
  hc.id                     as hmrc_client_id,
  hc.paye_ref,
  case
    when p.destination_realm is not null and e.id is not null then 'realm+name'
    when e.id is not null                                     then 'name'
    else 'unmatched'
  end                       as link_method
from payroll.employer p
left join lateral (
  select n.* from norm_e n
  where n.k = regexp_replace(
        regexp_replace(lower(p.brightpay_name), '\s+(limited|ltd|llp|plc)\.?$', ''),
        '[^a-z0-9]', '', 'g')
    and n.k <> ''
  order by (n.entity_status::text = 'active') desc, n.name
  limit 1
) e on true
left join hmrc.client hc on hc.entity_id = e.id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_brightpay_link is
  'BrightPay employer to Athena entity to PAYE scheme. Normalised-name match because destination_realm is mostly null. Unmatched employers appear with a null scheme deliberately — they are the work list.';

-- ── per scheme, per tax month ──────────────────────────────────────
create or replace view public.v_hmrc_paye_month_trend as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc."position"
  order by client_id, scraped_at desc
),
-- BrightPay states its liability for a period running 6th to 5th. Assign it to
-- the tax month the period ENDS in, which puts a quarterly employer's one row on
-- the last month it covers and a monthly employer's row on its own month.
bp as (
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
    -- Whole tax months the period spans: 1 for monthly, 3 for a quarterly filer.
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
    c.paye_ref,
    c.entity_id,
    c.name                              as hmrc_name,
    ch.tax_year,
    ch.tax_month,
    ch.charges, ch.credits, ch.payments, ch.amount_due
  from hmrc.charge ch
  join hmrc.client c on c.id = ch.client_id
  join latest l      on l.client_id = ch.client_id and l.run_id = ch.run_id
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
  -- The walk, at month grain: every prior month's residue plus this one's.
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
  -- Gross comparison: BrightPay's stated liability against what HMRC charged.
  -- Whether BrightPay is gross or net of EA is unproven until the two sources
  -- overlap, so the net variance is offered alongside rather than chosen.
  case when bk.bp_liability is not null
       then round(bk.bp_liability - m.charges / 100.0, 2) end          as variance_gross,
  case when bk.bp_liability is not null
       then round((bk.bp_liability - bk.bp_ea) - (m.charges - m.credits) / 100.0, 2) end as variance_net
from m
left join public.v_hmrc_paye_brightpay_link lk on lk.paye_ref = m.paye_ref
left join bp_keyed bk
       on bk.employer_id = lk.employer_id
      and bk.tax_year    = m.tax_year
      and bk.tax_month   = m.tax_month
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_month_trend is
  'Per scheme per tax MONTH: HMRC charges/credits/payments, the running balance, and BrightPay''s stated liability where it exists. brightpay_covered marks where reconciliation can start — everything before it is opening balance. Amounts in POUNDS.';

-- ── practice-wide monthly rollup ───────────────────────────────────
-- Small enough (one row per tax month) to pull whole and roll up to year or
-- total in the browser, which is what "by month, by tax year, by total" needs.
create or replace view public.v_hmrc_paye_trend_monthly as
select
  tax_year,
  tax_month,
  count(*)                                              as schemes,
  count(*) filter (where still_due > 0)                 as schemes_owing,
  sum(charges)                                          as charges,
  sum(credits)                                          as credits,
  sum(net_charged)                                      as net_charged,
  sum(payments)                                         as payments,
  sum(still_due)                                        as still_due,
  sum(cumulative_due)                                   as cumulative_due,
  count(*) filter (where brightpay_covered)             as brightpay_schemes,
  sum(bp_liability)                                     as bp_liability,
  sum(bp_ea)                                            as bp_ea,
  sum(variance_gross)                                   as variance_gross,
  bool_or(brightpay_covered)                            as brightpay_covered
from public.v_hmrc_paye_month_trend
group by tax_year, tax_month;

comment on view public.v_hmrc_paye_trend_monthly is
  'Practice-wide PAYE position per tax month — the base for month / tax-year / total aggregation. cumulative_due is the sum of every scheme''s running balance at that month, i.e. total money owed to HMRC as at that point. Amounts in POUNDS.';

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_brightpay_link', 'v_hmrc_paye_month_trend', 'v_hmrc_paye_trend_monthly'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
