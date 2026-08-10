-- 214 — Scope every tax head PER CLIENT, not per run.
--
-- Bobby: refreshes will be per client, re-scraping ALL of that client's
-- transactions rather than appending new ones, on top of a monthly sweep of
-- everybody.
--
-- That makes "the latest run for this service" an unsafe rule. A per-client
-- refresh writes a run containing ONE client, so any view keyed on
-- max(run_id) where service = X shows that one client and silently drops the
-- rest.
--
-- This is not hypothetical. CT run 5 scraped exactly one client (LJM Gas
-- Glasgow, 10 periods) between two full runs of 222. Had run 5 been the newest,
-- v_hmrc_client_tax_summary would have reported 1 client of 77 and looked
-- perfectly healthy doing it. There are already 11 runs across four services.
--
-- Same class of bug as sql/205 (charge depth varying by run) and the same fix:
-- for each CLIENT take the most recent run that actually carried data for them.
-- A narrow run can then never erase a wide one, and a single-client refresh
-- updates exactly that client.
--
-- ALSO: this stops depending on hmrc.ct_transfer, which scopes to the global
-- latest CT run and will therefore break the same way. Its classification is
-- mirrored here rather than reinvented — when the scraper scopes its own view
-- per client, this can go back to reading it.

-- ── per-client scope per tax head (internal) ────────────────────────
create or replace view public.v_hmrc_ct_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.ct_period
  union all
  select client_id, run_id from hmrc.ct_transaction
) s
group by client_id;

create or replace view public.v_hmrc_vat_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.vat_owed
  union all
  select client_id, run_id from hmrc.vat_payment
) s
group by client_id;

create or replace view public.v_hmrc_sa_scope as
select client_id, max(run_id) as run_id
from (
  select client_id, run_id from hmrc.sa_position
  union all
  select client_id, run_id from hmrc.sa_transaction
) s
group by client_id;

comment on view public.v_hmrc_ct_scope is
  'Per Corporation Tax client, the most recent run that carried data for them. THE scoping rule for CT — a global latest-run join drops every client a single-client refresh did not touch.';

revoke all on public.v_hmrc_ct_scope  from public, anon, authenticated;
revoke all on public.v_hmrc_vat_scope from public, anon, authenticated;
revoke all on public.v_hmrc_sa_scope  from public, anon, authenticated;

-- ── consolidated balances, per-client scoped ────────────────────────
create or replace view public.v_hmrc_client_tax_summary as
with paye as (
  select distinct on (p.client_id)
    c.entity_id, 'paye'::text as tax, c.paye_ref as reference,
    round(p.total_debt / 100.0, 2)        as balance,
    round(p.accruing_interest / 100.0, 2) as interest,
    p.payment_plan, p.scraped_at
  from hmrc."position" p
  join hmrc.client c on c.id = p.client_id
  order by p.client_id, p.scraped_at desc
),
ct as (
  select
    lk.entity_id, 'corporation-tax'::text as tax, lk.utr as reference,
    round(sum(pr.total) / 100.0, 2)    as balance,
    round(sum(pr.interest) / 100.0, 2) as interest,
    null::boolean                      as payment_plan,
    max(r.finished_at)                 as scraped_at
  from hmrc.ct_period pr
  join public.v_hmrc_ct_scope s on s.client_id = pr.client_id and s.run_id = pr.run_id
  join hmrc.run r               on r.id = pr.run_id
  join public.v_hmrc_ct_link lk on lk.ct_client_id = pr.client_id
  group by lk.entity_id, lk.utr
),
vat as (
  select
    vc.entity_id, 'vat'::text as tax, vc.vrn as reference,
    round(sum(o.amount) / 100.0, 2) as balance,
    null::numeric                   as interest,
    null::boolean                   as payment_plan,
    max(r.finished_at)              as scraped_at
  from hmrc.vat_owed o
  join public.v_hmrc_vat_scope s on s.client_id = o.client_id and s.run_id = o.run_id
  join hmrc.run r                on r.id = o.run_id
  join hmrc.vat_client vc        on vc.id = o.client_id
  group by vc.entity_id, vc.vrn
),
sa as (
  select
    sc.entity_id, 'self-assessment'::text as tax, sc.utr as reference,
    round(sum(p.total) / 100.0, 2)    as balance,
    round(sum(p.interest) / 100.0, 2) as interest,
    null::boolean                     as payment_plan,
    max(p.scraped_at)                 as scraped_at
  from hmrc.sa_position p
  join public.v_hmrc_sa_scope s on s.client_id = p.client_id and s.run_id = p.run_id
  join hmrc.sa_client sc        on sc.id = p.client_id
  group by sc.entity_id, sc.utr
),
all_tax as (
  select * from paye
  union all select * from ct
  union all select * from vat
  union all select * from sa
)
select
  t.entity_id,
  e.name                as entity_name,
  e.entity_status::text as entity_status,
  t.tax,
  t.reference,
  t.balance,
  t.interest,
  t.payment_plan,
  t.scraped_at
from all_tax t
join public.entities e on e.id = t.entity_id
where public.hmrc_can_read()
  and e.entity_status::text = 'active';

comment on view public.v_hmrc_client_tax_summary is
  'One row per active client per tax head with the balance HMRC currently shows. Scoped to each CLIENT''s latest run per tax, so a single-client refresh updates only that client. Amounts in POUNDS.';

-- ── money in and out, per-client scoped ─────────────────────────────
create or replace view public.v_hmrc_money_movements as
with ct_txn as (
  select t.*, cc.name as client_name, cc.utr
  from hmrc.ct_transaction t
  join public.v_hmrc_ct_scope s on s.client_id = t.client_id and s.run_id = t.run_id
  join hmrc.ct_client cc        on cc.id = t.client_id
  where t.line = 'repayment'
),
ct_classified as (
  select
    o.client_id, o.client_name, o.utr, o.period_end, o.txn_date, o.description,
    abs(o.amount) as amount,
    case
      when o.kind = 'repayment_cash'                          then 'cash_to_client'
      when o.kind = 'reallocation_ct'                         then 'internal_ct'
      when o.kind = 'transfer_other_tax' and m.id is not null  then 'internal_ct'
      when o.kind = 'transfer_other_tax' and o.direction = 'in'  then 'from_another_tax'
      when o.kind = 'transfer_other_tax' and o.direction = 'out' then 'to_another_tax'
      else 'unclear'
    end as movement
  from ct_txn o
  -- A transfer out that has a matching reallocation in on the same day for the
  -- same amount never left Corporation Tax; it moved between periods.
  left join ct_txn m
    on m.client_id = o.client_id
   and m.txn_date = o.txn_date
   and abs(m.amount) = abs(o.amount)
   and m.kind = 'reallocation_ct'
   and m.source_period_end = o.period_end
   and o.kind = 'transfer_other_tax'
   and o.direction = 'out'
)
select
  lk.entity_id,
  c.client_name              as hmrc_name,
  'corporation-tax'::text    as tax,
  c.utr                      as reference,
  c.txn_date,
  c.movement,
  c.description,
  c.period_end::text         as period,
  round(c.amount / 100.0, 2) as amount
from ct_classified c
join public.v_hmrc_ct_link lk on lk.ct_client_id = c.client_id
where c.movement in ('from_another_tax', 'to_another_tax', 'cash_to_client', 'internal_ct')

union all
select
  vc.entity_id,
  vc.name,
  'vat'::text,
  vc.vrn,
  p.txn_date,
  case
    when p.kind in ('repayment', 'repayment_interest')       then 'cash_to_client'
    when p.kind = 'transfer' and p.direction = 'from_hmrc'   then 'from_another_tax'
    when p.kind = 'transfer'                                 then 'to_another_tax'
    when p.direction = 'to_hmrc'                             then 'paid_by_client'
    else 'other'
  end,
  p.description,
  coalesce(p.period_from::text, '') ||
    case when p.period_to is not null then ' to ' || p.period_to::text else '' end,
  round(p.amount / 100.0, 2)
from hmrc.vat_payment p
join public.v_hmrc_vat_scope s on s.client_id = p.client_id and s.run_id = p.run_id
join hmrc.vat_client vc        on vc.id = p.client_id

union all
select
  sc.entity_id,
  sc.name,
  'self-assessment'::text,
  sc.utr,
  t.txn_date,
  case
    when t.direction = 'from_hmrc' then 'cash_to_client'
    when t.direction = 'to_hmrc'   then 'paid_by_client'
    else 'other'
  end,
  t.description,
  ''::text,
  round(abs(t.amount) / 100.0, 2)
from hmrc.sa_transaction t
join public.v_hmrc_sa_scope s on s.client_id = t.client_id and s.run_id = t.run_id
join hmrc.sa_client sc        on sc.id = t.client_id

union all
select
  c.entity_id,
  c.name,
  'paye'::text,
  c.paye_ref,
  public.hmrc_safe_date(p.received_on),
  'paid_by_client'::text,
  coalesce(p.allocated_to, 'Unallocated'),
  coalesce(p.allocated_year, ''),
  round(p.amount / 100.0, 2)
from hmrc.payment p
join hmrc.client c on c.id = p.client_id
where p.run_id = (select max(p2.run_id) from hmrc.payment p2 where p2.client_id = p.client_id)
  and coalesce(p.received_on, '') <> 'Total payment amount';

comment on view public.v_hmrc_money_movements is
  'Every movement of money between a client and HMRC across all four tax heads: cash_to_client (repayments out), paid_by_client, and from_another_tax / to_another_tax / internal_ct (credit reallocated). Scoped to each CLIENT''s latest run per tax. Mirrors hmrc.ct_transfer''s classification rather than reading it, because that view scopes to the global latest CT run and would drop clients a single-client refresh did not touch. Amounts in POUNDS.';

revoke all on public.v_hmrc_client_tax_summary from public, anon;
revoke all on public.v_hmrc_money_movements    from public, anon;
grant select on public.v_hmrc_client_tax_summary to authenticated, service_role;
grant select on public.v_hmrc_money_movements    to authenticated, service_role;
