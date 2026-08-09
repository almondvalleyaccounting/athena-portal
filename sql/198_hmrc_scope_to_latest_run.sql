-- 198 — HMRC views: scope every child table to the run that produced the
-- client's current position.
--
-- BUG sql/197 shipped with. The scraper APPENDS per run — it does not replace.
-- After the second scrape (run 2, 9 Aug 19:33) hmrc.overdue_item held 316 rows
-- from run 1 and 316 more from run 2, and v_hmrc_paye_clients aggregated across
-- both: Exodus Executive Hire showed 20 overdue charges where it has 10, and
-- overdue_interest / penalties were double counted. total_debt was never wrong
-- (it comes from the distinct-on latest position), which is exactly why this
-- slipped through — the headline figure looked right while the supporting
-- numbers silently doubled with every scrape.
--
-- The fix everywhere: `latest` already picks one position row per client; carry
-- its run_id and join the child tables on (client_id, run_id) so a view only
-- ever sees the scrape that produced the balance it is explaining.
--
-- link_exception is run-scoped rather than client-scoped, so it takes the
-- latest run outright. That is also the behaviour the Reconciliation tab
-- already claims: a cleared row that is still wrong gets re-raised by the next
-- scrape as a fresh row, and rows the scrape stops raising simply drop off.
--
-- Run 2 also widened hmrc.charge from the current tax year to seven
-- (2020-21 .. 2026-27, 12 months each). v_hmrc_paye_months therefore returns
-- many years now; it exposes tax_year so callers can pick, and the ordering
-- puts the most recent year first.

-- Dropped rather than replaced: scrape_run_id is a new column in the middle of
-- the select list, and create-or-replace can only append. Nothing depends on
-- this view, and the grant block at the end restores its permissions.
drop view if exists public.v_hmrc_paye_clients;

create view public.v_hmrc_paye_clients as
with latest as (
  select distinct on (p.client_id) p.*
  from hmrc.position p
  order by p.client_id, p.scraped_at desc
),
od as (
  select
    o.client_id,
    count(*)                                                          as overdue_items,
    count(*) filter (where o.section = 'monthly')                     as overdue_monthly_items,
    count(*) filter (where o.section = 'additional')                  as overdue_additional_items,
    count(*) filter (where o.charge_type = 'Penalty')                 as penalty_items,
    min(to_date(o.due_date, 'DD Mon YYYY'))                           as oldest_due_date,
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

create or replace view public.v_hmrc_paye_overdue as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc.position
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
  to_date(o.due_date, 'DD Mon YYYY')            as due_date,
  o.charge_type,
  round(o.interest   / 100.0, 2)                as interest,
  round(o.amount_due / 100.0, 2)                as amount_due
from hmrc.overdue_item o
join hmrc.client c on c.id = o.client_id
join latest l      on l.client_id = o.client_id and l.run_id = o.run_id
where public.hmrc_can_read();

create or replace view public.v_hmrc_paye_months as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc.position
  order by client_id, scraped_at desc
)
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
join hmrc.client c on c.id = ch.client_id
join latest l      on l.client_id = ch.client_id and l.run_id = ch.run_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_months is
  'Per-tax-month PAYE position, latest scrape only. Run 2 onward carries several tax years — filter on tax_year. Amounts in POUNDS.';

create or replace view public.v_hmrc_paye_payments as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc.position
  order by client_id, scraped_at desc
)
select
  p.id,
  c.paye_ref,
  c.entity_id,
  p.tax_year,
  p.received_on                                 as received_on_text,
  to_date(p.received_on, 'DD Mon YYYY')         as received_on,
  p.allocated_to,
  p.allocated_year,
  p.allocated_month,
  round(p.amount / 100.0, 2)                    as amount
from hmrc.payment p
join hmrc.client c on c.id = p.client_id
join latest l      on l.client_id = p.client_id and l.run_id = p.run_id
where public.hmrc_can_read();

create or replace view public.v_hmrc_paye_credits as
with latest as (
  select distinct on (client_id) client_id, run_id
  from hmrc.position
  order by client_id, scraped_at desc
)
select
  cr.id,
  c.paye_ref,
  c.entity_id,
  cr.tax_year,
  cr.credit_type,
  cr.allocated_to,
  cr.tax_month,
  round(cr.amount / 100.0, 2)                   as amount
from hmrc.credit cr
join hmrc.client c on c.id = cr.client_id
join latest l      on l.client_id = cr.client_id and l.run_id = cr.run_id
where public.hmrc_can_read();

-- Exceptions belong to a run, not a client: show the latest run's list only.
create or replace view public.v_hmrc_link_exceptions as
with norm as (
  select
    id,
    name,
    entity_status,
    regexp_replace(
      regexp_replace(lower(name), '\s+(limited|ltd|llp|plc)\.?$', ''),
      '[^a-z0-9]', '', 'g'
    ) as key
  from public.entities
),
current_run as (
  select max(run_id) as run_id from hmrc.link_exception
)
select
  x.id,
  x.run_id,
  x.paye_ref,
  x.hmrc_name,
  x.entity_id,
  x.entity_name,
  x.kind,
  x.athena_value,
  x.hmrc_value,
  x.proposed_sql,
  x.resolved,
  x.resolved_at,
  x.note,
  x.raised_at,
  s.id                    as suggested_entity_id,
  s.name                  as suggested_entity_name,
  s.entity_status::text   as suggested_entity_status
from hmrc.link_exception x
join current_run cr on x.run_id = cr.run_id
left join lateral (
  select n.id, n.name, n.entity_status
  from norm n
  where n.key = regexp_replace(
          regexp_replace(lower(x.hmrc_name), '\s+(limited|ltd|llp|plc)\.?$', ''),
          '[^a-z0-9]', '', 'g')
  order by (n.entity_status::text = 'active') desc, n.name
  limit 1
) s on true
where public.hmrc_can_read();

comment on view public.v_hmrc_link_exceptions is
  'Mismatches between the HMRC agent list and Athena, LATEST RUN ONLY — a scrape that stops raising a row means it is fixed, and one that re-raises it means it is not. Normalised-name suggestion where one exists.';

do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_clients', 'v_hmrc_paye_overdue', 'v_hmrc_paye_months',
    'v_hmrc_paye_payments', 'v_hmrc_paye_credits', 'v_hmrc_link_exceptions'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;
