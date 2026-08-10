-- 206 — Stop one unparseable date blanking a whole scheme.
--
-- Puddleduck Nursery shows £4,532.06 owed across 9 overdue items, and the detail
-- panel said "No overdue monthly bills", "No monthly rows scraped", "No payments
-- recorded" and "No credits applied" — everything empty, with a Postgres error
-- rendered in the middle of it: invalid value "To" for "DD".
--
-- Cause: hmrc.payment.received_on is not always a date. 291 of 1,524 rows carry
-- the literal 'Total payment amount' — the scraper is reading HMRC's table
-- footer as if it were a payment. to_date('Total payment amount', 'DD Mon YYYY')
-- throws, which failed v_hmrc_paye_payments, which failed the panel's
-- Promise.all, which left every one of its four sections with no data. A £0
-- label row took out the whole screen.
--
-- The money is unaffected: all 291 artefact rows have amount = 0, and the trend
-- reads hmrc.charge.payments rather than this table. Real payments still total
-- £1,803,277.23. Worth fixing at source in the scraper too, but the read side
-- should never have been this brittle.
--
-- Two changes:
--   1. hmrc_safe_date() — returns null instead of throwing. A date we cannot
--      read is a null date, not a broken page. The raw text stays exposed
--      alongside it (received_on_text / due_date_text) so nothing is hidden.
--   2. The known footer artefact is excluded from the payments view by name. It
--      is not a payment. Anything ELSE that fails to parse still appears, with a
--      null date and its raw text visible — a new artefact should be noticeable,
--      not silently swallowed.

create or replace function public.hmrc_safe_date(p_text text)
returns date
language sql
immutable
as $$
  -- CASE short-circuits, so to_date never sees a value that cannot parse.
  select case
    when p_text ~ '^\d{1,2} [A-Za-z]{3} \d{4}$'
    then to_date(p_text, 'DD Mon YYYY')
  end;
$$;

comment on function public.hmrc_safe_date(text) is
  'Parses HMRC''s "22 Jul 2024" date strings, returning NULL rather than raising for anything else. The scraper stores these as free text and they are not always dates — see sql/206.';

grant execute on function public.hmrc_safe_date(text) to authenticated, service_role;

-- ── payments ───────────────────────────────────────────────────────
create or replace view public.v_hmrc_paye_payments as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc."position"
  order by client_id, scraped_at desc
)
select
  p.id,
  c.paye_ref,
  c.entity_id,
  p.tax_year,
  p.received_on                                 as received_on_text,
  public.hmrc_safe_date(p.received_on)          as received_on,
  p.allocated_to,
  p.allocated_year,
  p.allocated_month,
  round(p.amount / 100.0, 2)                    as amount
from hmrc.payment p
join hmrc.client c on c.id = p.client_id
join latest l      on l.client_id = p.client_id and l.run_id = p.run_id
where public.hmrc_can_read()
  -- HMRC's "Total payment amount" footer row, scraped as if it were a payment.
  -- Always £0. Excluded by name so any other odd value still shows up.
  and coalesce(p.received_on, '') <> 'Total payment amount';

comment on view public.v_hmrc_paye_payments is
  'Payments HMRC has received against a PAYE scheme, and where they were allocated. Excludes the scraper''s "Total payment amount" footer artefact. Amounts in POUNDS.';

-- ── overdue items ──────────────────────────────────────────────────
-- Every due_date parses today, but the same free-text column and the same
-- to_date call: no reason to leave the trap armed.
create or replace view public.v_hmrc_paye_overdue as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc."position"
  order by client_id, scraped_at desc
)
select
  o.id,
  c.paye_ref,
  c.entity_id,
  o.section,
  o.period,
  o.tax_year,
  o.tax_month,
  o.due_date                                    as due_date_text,
  public.hmrc_safe_date(o.due_date)             as due_date,
  o.charge_type,
  round(o.interest   / 100.0, 2)                as interest,
  round(o.amount_due / 100.0, 2)                as amount_due
from hmrc.overdue_item o
join hmrc.client c on c.id = o.client_id
join latest l      on l.client_id = o.client_id and l.run_id = o.run_id
where public.hmrc_can_read();

-- v_hmrc_paye_clients derives oldest_due_date from the same column.
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
  coalesce(e.entity_status::text, 'no_athena_record') as athena_status,
  case
    when c.entity_id is null                                     then 'not_a_client'
    when e.entity_status::text = 'active'                        then 'client'
    when e.entity_status::text in ('archived', 'nlac')           then 'former_client'
    else 'unclear'
  end                                           as standing,
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
left join latest l           on l.client_id = c.id
left join od                 on od.client_id = c.id
left join public.entities e  on e.id = c.entity_id
left join public.hmrc_debt_reviews r on r.paye_ref = c.paye_ref
where public.hmrc_can_read();

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_payments', 'v_hmrc_paye_overdue', 'v_hmrc_paye_clients'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
