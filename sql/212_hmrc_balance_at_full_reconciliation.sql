-- 212 — Not-yet-due, derived opening balances, and one period rule.
--
-- Three faults found by Bobby reading the live screen, all in the same area.
--
-- 1. NOT YET DUE was being counted as debt. HMRC's total_debt counts only what
--    is OVERDUE. A charge raised for the current month but not payable until the
--    22nd of next month is not debt. Comparing the walk against total_debt on all
--    charged periods tied for only 96 of 141 schemes; comparing only periods now
--    DUE ties for 133. The difference is **£100,623.25 across the book** — money
--    that was sitting inside closing balances as though owed.
--
-- 2. THE OPENING BALANCE is derivable as the balancing figure, exactly as Bobby
--    said. Once the timing difference above is removed, 8 schemes still do not
--    tie. Two are on time-to-pay arrangements where HMRC has RESTATED the debt
--    downward (Anchor Gas -£21,623.87, Itcc -£16,748.14); that is a later
--    adjustment, not pre-2020 history, and booking it as an opening balance would
--    make the statement tie while attributing it to the wrong thing. The other
--    six are small and positive (Cruse +£307.05 down to Multiplied By +£0.55) and
--    look like genuine opening balance or charges outside the monthly grid.
--    So: derive an opening balance for those, and show a restatement as its own
--    line. Both tie; only one tells the truth about why.
--
-- 3. ONE PERIOD RULE. The statement table selected months by period_START while
--    this function counted them by period_END. At a 31 May cut-off the table
--    therefore showed tax month 2 (6 May to 5 Jun) and its payments — including
--    one received 17 June — while the proof excluded the month and reported
--    "nothing paid after 31 May". Both defensible alone, contradictory together.
--    period_end is the correct rule (a period that has not ended is not yet a
--    liability) and the UI now filters on it too.

drop function if exists public.hmrc_paye_balance_at(text, date);

create function public.hmrc_paye_balance_at(
  p_paye_ref text,
  p_as_at    date
)
returns table (
  as_at                      date,
  opening_balance            numeric,  -- derived plug where the walk cannot tie
  net_charged                numeric,
  charges                    numeric,
  credits                    numeric,
  payments_ever_allocated    numeric,
  still_unpaid_today         numeric,
  paid_after                 numeric,
  paid_after_count           integer,
  restatement                numeric,  -- HMRC writing the debt down, e.g. time to pay
  balance_at                 numeric,
  periods_counted            integer,
  last_period_end            date,
  not_yet_due                numeric,  -- charged, not payable yet: never debt
  stated_debt_today          numeric,
  residual_kind              text,     -- 'ties' | 'opening_balance' | 'restatement'
  basis                      text,     -- 'exact' | 'minimum'
  earliest_payment_held      date
)
language sql
stable
security definer
set search_path = public, hmrc
as $$
  with scoped as (
    select ch.*,
           (public.hmrc_tax_period_start(ch.tax_year, ch.tax_month)
              + interval '1 month - 1 day')::date as period_end,
           (public.hmrc_tax_period_start(ch.tax_year, ch.tax_month)
              + interval '1 month 16 days')::date as due_on
    from hmrc.charge ch
    join public.v_hmrc_charge_scope s
      on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
    join hmrc.client c on c.id = ch.client_id
    where c.paye_ref = p_paye_ref
  ),
  -- A period is in the balance only once it has ENDED. This is the single rule;
  -- the statement table uses it too.
  upto as (select * from scoped where period_end <= p_as_at),
  agg as (
    select
      coalesce(sum(charges), 0)                 as charges_p,
      coalesce(sum(credits), 0)                 as credits_p,
      coalesce(sum(charges) - sum(credits), 0)  as net_p,
      coalesce(sum(payments), 0)                as paid_ever_p,
      count(*)::int                             as periods,
      max(period_end)                           as last_pe
    from upto
  ),
  -- Whole-scheme reconciliation, to decide whether an opening balance is needed.
  whole as (
    select
      coalesce(sum(amount_due) filter (where due_on <= current_date), 0) as due_movements_p,
      coalesce(sum(amount_due) filter (where due_on >  current_date), 0) as not_yet_due_p
    from scoped
  ),
  pos as (
    select p.total_debt, p.payment_plan
    from hmrc."position" p
    join hmrc.client c on c.id = p.client_id
    where c.paye_ref = p_paye_ref
    order by p.scraped_at desc
    limit 1
  ),
  later as (
    select
      coalesce(sum(p.amount), 0) as paid_after_p,
      count(*)::int              as paid_after_n
    from hmrc.payment p
    join hmrc.client c on c.id = p.client_id
    where c.paye_ref = p_paye_ref
      and p.run_id = (select max(p2.run_id) from hmrc.payment p2 where p2.client_id = c.id)
      and public.hmrc_safe_date(p.received_on) > p_as_at
      and p.allocated_year is not null and p.allocated_month is not null
      and (public.hmrc_tax_period_start(p.allocated_year, p.allocated_month)
             + interval '1 month - 1 day')::date <= p_as_at
  ),
  cover as (select min(public.hmrc_safe_date(received_on)) as earliest from hmrc.payment),
  resid as (
    select
      pos.total_debt - whole.due_movements_p as residual_p,
      pos.payment_plan
    from pos, whole
  ),
  parts as (
    select
      -- The plug. Only booked as an opening balance where it is not HMRC writing
      -- the debt down; a restatement gets its own line so it is not misread as
      -- pre-history.
      case when resid.residual_p = 0 then 0
           when resid.payment_plan is true then 0
           else resid.residual_p end                                as opening_p,
      case when resid.residual_p = 0 then 0
           when resid.payment_plan is true then resid.residual_p
           else 0 end                                               as restate_p,
      case when resid.residual_p = 0 then 'ties'
           when resid.payment_plan is true then 'restatement'
           else 'opening_balance' end                               as kind
    from resid
  )
  select
    p_as_at,
    round(parts.opening_p   / 100.0, 2),
    round(agg.net_p         / 100.0, 2),
    round(agg.charges_p     / 100.0, 2),
    round(agg.credits_p     / 100.0, 2),
    round(agg.paid_ever_p   / 100.0, 2),
    round((agg.net_p - agg.paid_ever_p) / 100.0, 2),
    round(later.paid_after_p / 100.0, 2),
    later.paid_after_n,
    round(parts.restate_p   / 100.0, 2),
    round((parts.opening_p + (agg.net_p - agg.paid_ever_p)
             + later.paid_after_p + parts.restate_p) / 100.0, 2),
    agg.periods,
    agg.last_pe,
    round(whole.not_yet_due_p / 100.0, 2),
    round(pos.total_debt      / 100.0, 2),
    parts.kind,
    case when p_as_at >= cover.earliest then 'exact' else 'minimum' end,
    cover.earliest
  from agg, later, cover, whole, pos, parts
  where public.hmrc_can_read();
$$;

comment on function public.hmrc_paye_balance_at(text, date) is
  'PAYE balance owed at a point in time. A period counts only once it has ENDED (period_end <= the date) — '
  'the same rule the statement table uses. balance_at = opening_balance + still_unpaid_today + paid_after + '
  'restatement. opening_balance is the derived plug that makes the walk tie to HMRC''s overdue figure, booked '
  'only where the gap is not HMRC restating the debt (time-to-pay), which gets its own restatement line. '
  'not_yet_due is charged-but-not-payable and is never debt. basis ''exact'' within our dated payment history, '
  '''minimum'' before it. Amounts in POUNDS.';

revoke all on function public.hmrc_paye_balance_at(text, date) from public, anon;
grant execute on function public.hmrc_paye_balance_at(text, date) to authenticated, service_role;
