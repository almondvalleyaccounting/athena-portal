-- 204 — Filterable trend, and the observed position history.
--
-- Two things Bobby asked for after seeing the trend: make it filterable, and
-- make it downloadable for year-end analysis.
--
-- NO SNAPSHOT TABLE. The obvious build here is a nightly snapshot of practice
-- debt, but hmrc."position" ALREADY keeps one dated observation per client per
-- run and the scraper never overwrites it — three runs on 9 Aug are all still
-- there, each with its own scraped_at. A snapshot table would be a second copy
-- of a series we already hold, drifting the moment one of them missed a run.
-- So the history here is a view over run data, which also means it covers every
-- run already taken rather than starting from today.
--
-- What that DOES NOT give us: a reconstructed balance at a past date.
-- hmrc.payment and hmrc.credit only carry the current tax year, so for any date
-- before the first run we can say which months' charges are STILL unpaid, but
-- not what was outstanding at the time. Those are different numbers and the
-- difference matters for a year-end accrual. The run series is exact from
-- 2026-08-09 forward and gets more useful every week; year-end figures before
-- that must be read as "arrears originating on or before this date, still unpaid
-- today", which is what the Trend tab's walk shows.

-- ── filter dimensions on the month grain ───────────────────────────
-- Appended at the end: create-or-replace can add columns but not reorder them.
create or replace view public.v_hmrc_paye_month_trend as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc."position"
  order by client_id, scraped_at desc
),
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
  -- Filter dimensions. Carried here so the trend can be sliced without the
  -- caller re-deriving standing or re-joining entities.
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

-- ── filtered monthly rollup ────────────────────────────────────────
-- Aggregation has to happen AFTER filtering, so a pre-aggregated view cannot
-- serve a filtered request. One function, null meaning "no filter", keeps it to
-- a single round trip and returns at most one row per tax month.
create or replace function public.hmrc_trend_monthly(
  p_entity_ids uuid[]  default null,
  p_tiers      int[]   default null,
  p_standings  text[]  default null,
  p_managers   text[]  default null
)
returns table (
  tax_year          text,
  tax_month         smallint,
  schemes            bigint,
  schemes_owing      bigint,
  charges            numeric,
  credits            numeric,
  net_charged        numeric,
  payments           numeric,
  still_due          numeric,
  cumulative_due     numeric,
  brightpay_schemes  bigint,
  bp_liability       numeric,
  bp_ea              numeric,
  variance_gross     numeric,
  brightpay_covered  boolean
)
language sql
stable
security definer
set search_path = public, hmrc
as $$
  select
    t.tax_year,
    t.tax_month,
    count(*),
    count(*) filter (where t.still_due > 0),
    sum(t.charges),
    sum(t.credits),
    sum(t.net_charged),
    sum(t.payments),
    sum(t.still_due),
    sum(t.cumulative_due),
    count(*) filter (where t.brightpay_covered),
    sum(t.bp_liability),
    sum(t.bp_ea),
    sum(t.variance_gross),
    bool_or(t.brightpay_covered)
  from public.v_hmrc_paye_month_trend t
  where public.hmrc_can_read()
    and (p_entity_ids is null or t.entity_id = any (p_entity_ids))
    and (p_tiers      is null or t.chase_tier = any (p_tiers))
    and (p_standings  is null or t.standing   = any (p_standings))
    and (p_managers   is null or t.manager    = any (p_managers))
  group by t.tax_year, t.tax_month
  order by t.tax_year, t.tax_month;
$$;

comment on function public.hmrc_trend_monthly(uuid[], int[], text[], text[]) is
  'Monthly PAYE trend rolled up across whichever schemes match the filters. NULL argument = no filter on that dimension. Amounts in POUNDS.';

-- ── the observed position history ──────────────────────────────────
-- One row per scrape: what the whole book owed when we looked. This is the
-- series that makes year-end figures exact going forward.
create or replace view public.v_hmrc_paye_debt_history as
with per_run as (
  select
    r.id                                        as run_id,
    r.service,
    r.tax_year                                  as scraped_tax_year,
    r.started_at,
    r.finished_at,
    r.clients_seen,
    r.clients_failed,
    count(p.*)                                  as schemes,
    count(*) filter (where p.total_debt > 0)     as schemes_owing,
    sum(p.total_debt)                           as total_debt,
    sum(p.accruing_interest)                    as accruing_interest,
    count(*) filter (where p.payment_plan)       as schemes_on_plan
  from hmrc.run r
  join hmrc."position" p on p.run_id = r.id
  group by r.id, r.service, r.tax_year, r.started_at, r.finished_at,
           r.clients_seen, r.clients_failed
)
select
  run_id,
  service,
  scraped_tax_year,
  started_at,
  finished_at,
  coalesce(finished_at, started_at)::date        as observed_on,
  round(extract(epoch from (finished_at - started_at)) / 60.0, 1) as run_minutes,
  clients_seen,
  clients_failed,
  schemes,
  schemes_owing,
  round(total_debt        / 100.0, 2)            as total_debt,
  round(accruing_interest / 100.0, 2)            as accruing_interest,
  schemes_on_plan,
  round((total_debt - lag(total_debt) over (partition by service order by run_id)) / 100.0, 2)
                                                 as debt_change,
  lag(coalesce(finished_at, started_at)) over (partition by service order by run_id)
                                                 as previous_observed_at
from per_run
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_debt_history is
  'One row per scrape: total PAYE debt across the book when we looked, with the movement since the previous scrape. The exact point-in-time series — reliable from the first run (2026-08-09) forward. Amounts in POUNDS.';

-- Per scheme per scrape, so "who got worse since last time" is answerable.
create or replace view public.v_hmrc_paye_scheme_history as
select
  c.paye_ref,
  c.entity_id,
  c.name                                         as hmrc_name,
  p.run_id,
  p.scraped_at,
  p.scraped_at::date                             as observed_on,
  p.tax_year,
  round(p.total_debt        / 100.0, 2)          as total_debt,
  round(p.accruing_interest / 100.0, 2)          as accruing_interest,
  p.payment_plan,
  round((p.total_debt - lag(p.total_debt) over (partition by p.client_id order by p.scraped_at)) / 100.0, 2)
                                                 as debt_change
from hmrc."position" p
join hmrc.client c on c.id = p.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_scheme_history is
  'Per scheme per scrape, with the movement since that scheme was last observed. Amounts in POUNDS.';

-- ── grants ─────────────────────────────────────────────────────────
do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_month_trend', 'v_hmrc_paye_debt_history', 'v_hmrc_paye_scheme_history'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;

revoke all on function public.hmrc_trend_monthly(uuid[], int[], text[], text[]) from public, anon;
grant execute on function public.hmrc_trend_monthly(uuid[], int[], text[], text[]) to authenticated, service_role;
