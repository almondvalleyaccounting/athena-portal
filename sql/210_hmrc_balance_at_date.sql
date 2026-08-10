-- 210 — Prove the PAYE balance at a point in time, and find the company year.
--
-- Bobby: "a bill may be paid now, but if the payment happened after the company
-- year end then it would have been an open bill at that point in time."
--
-- That is a different number from anything the module held. The statement's
-- `closing` is the residue still unpaid TODAY. What a set of accounts needs is
-- what was outstanding ON the year-end date, and the difference between the two
-- is precisely the money paid since.
--
-- The identity the function returns, which is also the proof:
--
--     balance at date  =  still unpaid today  +  paid after the date
--
-- Both right-hand terms are things we can evidence per payment, so the figure is
-- defensible line by line rather than asserted.
--
-- WHY IT IS ONLY EXACT FROM 6 APRIL 2026. hmrc.charge.payments gives the total
-- ever paid against each tax month — complete, but undated. hmrc.payment gives
-- dates, but the scrape only returns the CURRENT tax year's payment history:
-- every one of the 423 rows we hold was received between 2026-04-06 and
-- 2026-08-07.
--
-- So for a date on or after 6 Apr 2026 we can see every payment that landed
-- after it, and the balance is exact. For an earlier date, a payment made
-- between that date and 6 Apr 2026 is invisible to us, `paid_after` is
-- understated, and the balance we compute is therefore a MINIMUM — it was at
-- least that much. `basis` says which you are looking at; never present a
-- minimum as a proven figure.
--
-- Only 59 of 278 clients have a 31 March year end. 34 are 31 December, 25 are
-- 31 July. Most of them will be reading a minimum until the payment history
-- deepens, which is one more reason to keep scraping weekly.

-- ── company year end, parsed from BrightManager task names ─────────
-- Athena stores no year-end column. It is embedded in the BM task name
-- ("Accounts Preparation Year End 31/03/2026"), which is how the job-review
-- module already reads it. 133 of the 140 HMRC-linked clients resolve.
create or replace view public.v_hmrc_client_year_end as
with ye as (
  select
    t.entity_id,
    to_date(substring(t.bm_task_name from 'Year End (\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as year_end
  from public.bm_task_schedule t
  where t.bm_task_name ~ 'Year End \d{2}/\d{2}/\d{4}'
),
per_entity as (
  select
    entity_id,
    max(year_end) filter (where year_end <= current_date) as latest_year_end,
    min(year_end) filter (where year_end >  current_date) as next_year_end
  from ye
  group by entity_id
)
select
  c.paye_ref,
  c.entity_id,
  p.latest_year_end,
  p.next_year_end,
  -- The most recent COMPLETED accounting year: the twelve months ending on the
  -- last year end that has passed. Falls back to the year before the next one
  -- where a client has no completed year end recorded yet.
  coalesce(p.latest_year_end, (p.next_year_end - interval '1 year')::date) as year_end,
  (coalesce(p.latest_year_end, (p.next_year_end - interval '1 year')::date)
     - interval '1 year' + interval '1 day')::date                          as year_start
from hmrc.client c
join public.entities e  on e.id = c.entity_id and e.entity_status::text = 'active'
join per_entity p       on p.entity_id = c.entity_id
where public.hmrc_can_read();

comment on view public.v_hmrc_client_year_end is
  'Company accounting year per PAYE scheme, parsed from BrightManager task names ("... Year End 31/03/2026") because Athena holds no year-end column. year_start/year_end bound the most recent completed year — what the Client statement''s "Company year" button uses.';

revoke all on public.v_hmrc_client_year_end from public, anon;
grant select on public.v_hmrc_client_year_end to authenticated, service_role;

-- ── the point-in-time proof ────────────────────────────────────────
create or replace function public.hmrc_paye_balance_at(
  p_paye_ref text,
  p_as_at    date
)
returns table (
  as_at                      date,
  net_charged                numeric,   -- charges less credits, periods ending on/before the date
  charges                    numeric,
  credits                    numeric,
  payments_ever_allocated    numeric,   -- total ever paid against those periods (undated, complete)
  still_unpaid_today         numeric,
  paid_after                 numeric,   -- received AFTER the date, against those periods
  paid_after_count           integer,
  balance_at                 numeric,   -- still_unpaid_today + paid_after
  periods_counted            integer,
  last_period_end            date,
  basis                      text,      -- 'exact' | 'minimum'
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
              + interval '1 month - 1 day')::date as period_end
    from hmrc.charge ch
    join public.v_hmrc_charge_scope s
      on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
    join hmrc.client c on c.id = ch.client_id
    where c.paye_ref = p_paye_ref
  ),
  upto as (
    select * from scoped where period_end <= p_as_at
  ),
  agg as (
    select
      coalesce(sum(charges), 0)                              as charges_p,
      coalesce(sum(credits), 0)                              as credits_p,
      coalesce(sum(charges) - sum(credits), 0)               as net_p,
      coalesce(sum(payments), 0)                             as paid_ever_p,
      count(*)::int                                          as periods,
      max(period_end)                                        as last_pe
    from upto
  ),
  later as (
    -- Payments received after the date but set against a period on/before it.
    -- This is the money that makes today's position look settled when it was
    -- open at the date in question.
    select
      coalesce(sum(p.amount), 0) as paid_after_p,
      count(*)::int              as paid_after_n
    from hmrc.payment p
    join hmrc.client c on c.id = p.client_id
    where c.paye_ref = p_paye_ref
      -- Payment rows repeat per scrape; take the newest set for this client only.
      and p.run_id = (select max(p2.run_id) from hmrc.payment p2 where p2.client_id = c.id)
      and public.hmrc_safe_date(p.received_on) > p_as_at
      and p.allocated_year is not null and p.allocated_month is not null
      and (public.hmrc_tax_period_start(p.allocated_year, p.allocated_month)
             + interval '1 month - 1 day')::date <= p_as_at
  ),
  cover as (
    select min(public.hmrc_safe_date(received_on)) as earliest
    from hmrc.payment
  )
  select
    p_as_at,
    round(agg.net_p        / 100.0, 2),
    round(agg.charges_p    / 100.0, 2),
    round(agg.credits_p    / 100.0, 2),
    round(agg.paid_ever_p  / 100.0, 2),
    round((agg.net_p - agg.paid_ever_p) / 100.0, 2),
    round(later.paid_after_p / 100.0, 2),
    later.paid_after_n,
    round(((agg.net_p - agg.paid_ever_p) + later.paid_after_p) / 100.0, 2),
    agg.periods,
    agg.last_pe,
    case when p_as_at >= cover.earliest then 'exact' else 'minimum' end,
    cover.earliest
  from agg, later, cover
  where public.hmrc_can_read();
$$;

comment on function public.hmrc_paye_balance_at(text, date) is
  'PAYE balance owed at a point in time: balance_at = still_unpaid_today + paid_after, where paid_after is '
  'money received after the date against periods ending on or before it. basis = ''exact'' when the date is '
  'within our dated payment history, ''minimum'' when it predates it (payments we cannot see may have landed '
  'after the date, so the true balance was at least this). Amounts in POUNDS.';

revoke all on function public.hmrc_paye_balance_at(text, date) from public, anon;
grant execute on function public.hmrc_paye_balance_at(text, date) to authenticated, service_role;
