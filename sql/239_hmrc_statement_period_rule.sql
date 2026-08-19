-- 239 — Which tax month a year end belongs to, and what "owed at that date" means.
--
-- Two faults, one cause. Bobby, reading the Client statement:
--
--   "Take Antonine with a company year ending 31st January. I should see the 12
--    months PAYE with the month ending 5th February, not 5th January."
--
--   "Take Village Estates. As at 31st December 2025 they owed £437.50 as this
--    was paid January 2026 — the 'owed at' should be £437.50."
--
-- Both come from sql/212's period rule: a tax month counted only once its
-- period had ENDED (period_end <= the date). That rule answers "what is overdue
-- today". It is the wrong rule for "what did this company owe HMRC at its year
-- end", which is what the statement is for.
--
-- WHY. A tax month runs 6th to 5th. The payroll a company runs in January is
-- paid inside tax month 6 Jan – 5 Feb and charged there. So a 31 January year
-- end accrues that month; a 31 March year end accrues 6 Mar – 5 Apr; a
-- 31 December year end accrues 6 Dec – 5 Jan. Under the old rule every single
-- client lost their final month, and the creditor was understated by one
-- month's PAYE — for Village Estates, by the whole balance.
--
-- THE NEW RULE. A tax month belongs to the period that contains its START.
--   include the month when  period_start <= as_at
-- which is the same as saying "every month up to and including the one the date
-- falls in". The statement table filters on period_start for the same reason,
-- so both ends of a company year land on the right month.
--
-- WHEN WAS IT PAID. HMRC gives us a per-month payments total with no date, plus
-- a dated payment history that only reaches back to the current tax year. So
-- sql/212 could only ever say "still unpaid today, plus what we can see was paid
-- after the date". For the month a year end falls in that is useless — the
-- payment lands weeks later and we hold no date for it.
--
-- But we do not need a date for it. That month is not payable until the 22nd of
-- the month after it ends. If a month's DUE DATE is after the as-at date, its
-- payments cannot have been made before the as-at date, whatever we hold. So:
--
--   months due on or before the date  →  dated evidence, as before
--   months due after the date         →  every payment against them is "after"
--
-- Village Estates at 31 Dec 2025: tax month 6 Dec – 5 Jan is due 22 Jan, so its
-- £437.50 is proven to have been outstanding on the date without needing a
-- payment date at all. That is the figure Bobby expected.
--
-- TWO NUMBERS, NOT ONE. Including the straddling month means the balance now
-- contains charges not yet payable at the date. That is right for a creditor in
-- a set of accounts and wrong for a comparison with HMRC's own debt figure,
-- which counts only what is overdue. The function returns both:
--
--   balance_at      the creditor at the date, not-yet-due included
--   not_yet_due_at  the part of it not payable until after the date
--   overdue_at      balance_at - not_yet_due_at, comparable to HMRC's number
--
-- and overdue_at is now on exactly the basis (due_on <= date) that the opening
-- balance plug is derived on, which the old balance_at was not — so the walk and
-- the reconciliation finally use one rule between them.
--
-- BASIS. sql/212 read earliest_payment_held as the minimum date across the WHOLE
-- payment table, so one client's 2020 row made every other client's history look
-- deep and the function reported 'exact' where it held nothing. It is per scheme
-- now. Village Estates holds no payment before 22 Apr 2026; at 31 Dec 2025 that
-- is a minimum, and saying so is the point.

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
  paid_after                 numeric,  -- everything that landed after the date
  paid_after_count           integer,  -- of which we hold a dated record
  paid_after_not_due         numeric,  -- inferred from the due date, no date held
  restatement                numeric,  -- HMRC writing the debt down, e.g. time to pay
  balance_at                 numeric,  -- the creditor at the date
  not_yet_due_at             numeric,  -- of that, not payable until after the date
  overdue_at                 numeric,  -- balance_at less not_yet_due_at
  periods_counted            integer,
  first_period_start         date,
  last_period_end            date,
  last_period_due            date,
  stated_debt_today          numeric,
  residual_kind              text,     -- 'ties' | 'opening_balance' | 'restatement'
  basis                      text,     -- 'exact' | 'minimum'
  earliest_payment_held      date      -- for THIS scheme
)
language sql
stable
security definer
set search_path = public, hmrc
as $$
  with scoped as (
    select ch.*,
           public.hmrc_tax_period_start(ch.tax_year, ch.tax_month)               as period_start,
           (public.hmrc_tax_period_start(ch.tax_year, ch.tax_month)
              + interval '1 month - 1 day')::date                                as period_end,
           -- HMRC's electronic deadline: the 22nd after the month ends.
           (public.hmrc_tax_period_start(ch.tax_year, ch.tax_month)
              + interval '1 month 16 days')::date                                as due_on
    from hmrc.charge ch
    join public.v_hmrc_charge_scope s
      on s.client_id = ch.client_id and s.tax_year = ch.tax_year and s.run_id = ch.run_id
    join hmrc.client c on c.id = ch.client_id
    where c.paye_ref = p_paye_ref
  ),
  -- A month belongs to the period containing its START. This is the single
  -- rule; the statement table uses it too.
  upto as (select * from scoped where period_start <= p_as_at),
  agg as (
    select
      coalesce(sum(charges), 0)                 as charges_p,
      coalesce(sum(credits), 0)                 as credits_p,
      coalesce(sum(charges) - sum(credits), 0)  as net_p,
      coalesce(sum(payments), 0)                as paid_ever_p,
      count(*)::int                             as periods,
      min(period_start)                         as first_ps,
      max(period_end)                           as last_pe,
      max(due_on)                               as last_due
    from upto
  ),
  -- Charged by the date but not payable until after it. Nothing against these
  -- months can have been paid before the date, so all of it is "paid after".
  notdue as (
    select
      coalesce(sum(charges) - sum(credits), 0) as nd_net_p,
      coalesce(sum(payments), 0)               as nd_paid_p
    from upto where due_on > p_as_at
  ),
  -- Whole-scheme reconciliation, to decide whether an opening balance is needed.
  whole as (
    select
      coalesce(sum(amount_due) filter (where due_on <= current_date), 0) as due_movements_p
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
  -- Dated payments that landed after the date against a month that was ALREADY
  -- DUE by then. Months not yet due are handled above; counting them here too
  -- would double them.
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
      and (public.hmrc_tax_period_start(p.allocated_year, p.allocated_month)
             + interval '1 month 16 days')::date <= p_as_at
  ),
  -- How far back the DATED history reaches for this scheme. Anything before it
  -- is undated, so a payment made between the date and then is invisible.
  cover as (
    select min(public.hmrc_safe_date(p.received_on)) as earliest
    from hmrc.payment p
    join hmrc.client c on c.id = p.client_id
    where c.paye_ref = p_paye_ref
      and p.run_id = (select max(p2.run_id) from hmrc.payment p2 where p2.client_id = c.id)
  ),
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
  ),
  final as (
    select
      parts.opening_p
        + (agg.net_p - agg.paid_ever_p)
        + (later.paid_after_p + notdue.nd_paid_p)
        + parts.restate_p                                           as balance_p,
      notdue.nd_net_p                                               as not_yet_due_p
    from agg, later, notdue, parts
  )
  select
    p_as_at,
    round(parts.opening_p    / 100.0, 2),
    round(agg.net_p          / 100.0, 2),
    round(agg.charges_p      / 100.0, 2),
    round(agg.credits_p      / 100.0, 2),
    round(agg.paid_ever_p    / 100.0, 2),
    round((agg.net_p - agg.paid_ever_p) / 100.0, 2),
    round((later.paid_after_p + notdue.nd_paid_p) / 100.0, 2),
    later.paid_after_n,
    round(notdue.nd_paid_p   / 100.0, 2),
    round(parts.restate_p    / 100.0, 2),
    round(final.balance_p    / 100.0, 2),
    round(final.not_yet_due_p / 100.0, 2),
    round((final.balance_p - final.not_yet_due_p) / 100.0, 2),
    agg.periods,
    agg.first_ps,
    agg.last_pe,
    agg.last_due,
    round(pos.total_debt     / 100.0, 2),
    parts.kind,
    case when cover.earliest is not null and p_as_at >= cover.earliest
         then 'exact' else 'minimum' end,
    cover.earliest
  from agg, later, notdue, cover, whole, pos, parts, final
  where public.hmrc_can_read();
$$;

comment on function public.hmrc_paye_balance_at(text, date) is
  'PAYE owed at a point in time. A tax month belongs to the period containing its START (period_start <= the '
  'date), so a 31 January year end accrues the month ending 5 February — the same rule the statement table '
  'uses. balance_at = opening_balance + still_unpaid_today + paid_after + restatement, where paid_after is '
  'dated payments received after the date against months already due by then, PLUS every payment against '
  'months not yet due at the date (which cannot have been paid before it). not_yet_due_at is the part of '
  'balance_at not payable until after the date; overdue_at is the rest and is what compares with HMRC''s own '
  'debt figure. basis ''exact'' when this scheme''s dated payment history reaches back to the date, '
  '''minimum'' when it does not. Amounts in POUNDS.';

revoke all on function public.hmrc_paye_balance_at(text, date) from public, anon;
grant execute on function public.hmrc_paye_balance_at(text, date) to authenticated, service_role;
