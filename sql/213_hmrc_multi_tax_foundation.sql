-- 213 — The mapping that makes a consolidated HMRC dashboard possible.
--
-- The scraper now pulls PAYE, Corporation Tax and VAT (Self Assessment tables
-- exist but are still empty), and has already built the cross-tax movement
-- layer: hmrc.ct_transfer classifies every CT repayment line as cash_to_client /
-- from_another_tax / to_another_tax / internal_ct, and hmrc.money_movement unions
-- that with VAT. That work is not duplicated here.
--
-- THE BLOCKER was the mapping Bobby referred to. hmrc.ct_client.entity_id is NULL
-- for all 222 rows, so every CT figure — including all of the reallocation and
-- repayment data, which is where the CIS credit story lives — could not be
-- attributed to a client. VAT (91/91) and PAYE (141/141) are linked; CT was not.
--
-- Derived rather than written back, so the scraper stays the only writer of its
-- own tables (same approach as v_hmrc_paye_brightpay_link). 219 of 222 resolve:
-- 7 on company number, 212 on normalised name. The 3 that fail are HMRC
-- truncating the name ("LOCAL PLANET SOLUTIONS LIMIT", "OSIRIS EDUCATIONAL
-- WOODHALL") and they stay visible with a null entity rather than vanishing.
--
-- Note ct_client.company_number is NOT a Companies House number — the values are
-- 6-7 digits ("184227") where Companies House is 8 characters ("SC325774"). Only
-- 7 matched that way, so name is the workhorse and company number is the
-- tie-breaker, not the primary key.

-- ── CT client → Athena entity ──────────────────────────────────────
create or replace view public.v_hmrc_ct_link as
with norm_e as (
  select
    id, name, entity_status,
    nullif(regexp_replace(coalesce(company_number, ''), '[^0-9A-Za-z]', '', 'g'), '') as cn,
    regexp_replace(
      regexp_replace(lower(name), '\s+(limited|ltd|llp|plc)\.?$', ''),
      '[^a-z0-9]', '', 'g') as k
  from public.entities
),
norm_c as (
  select
    c.*,
    nullif(regexp_replace(coalesce(c.company_number, ''), '[^0-9A-Za-z]', '', 'g'), '') as cn,
    regexp_replace(
      regexp_replace(lower(c.name), '\s+(limited|ltd|llp|plc)\.?$', ''),
      '[^a-z0-9]', '', 'g') as k
  from hmrc.ct_client c
)
select
  c.id                      as ct_client_id,
  c.utr,
  c.name                    as hmrc_name,
  c.company_number          as hmrc_company_number,
  c.your_reference,
  coalesce(bycn.id, byname.id)                        as entity_id,
  coalesce(bycn.name, byname.name)                    as entity_name,
  coalesce(bycn.entity_status, byname.entity_status)::text as entity_status,
  case
    when bycn.id is not null and byname.id is not null and bycn.id <> byname.id then 'conflict'
    when bycn.id is not null  then 'company_number'
    when byname.id is not null then 'name'
    else 'unmatched'
  end                       as link_method
from norm_c c
left join lateral (
  select e.* from norm_e e where e.cn is not null and e.cn = c.cn limit 1
) bycn on true
left join lateral (
  select e.* from norm_e e
  where e.k = c.k and e.k <> ''
  order by (e.entity_status::text = 'active') desc, e.name
  limit 1
) byname on true
where public.hmrc_can_read();

comment on view public.v_hmrc_ct_link is
  'Corporation Tax client to Athena entity. Derived, not written back — the scraper stays the only writer of hmrc.ct_client, whose entity_id is NULL for every row. Matched on normalised name with company number as tie-breaker; link_method ''conflict'' means the two disagree and ''unmatched'' means neither hit (HMRC truncates some names).';

revoke all on public.v_hmrc_ct_link from public, anon;
grant select on public.v_hmrc_ct_link to authenticated, service_role;

-- ── one row per client per tax: the consolidated dashboard ─────────
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
    round(sum(pr.total) / 100.0, 2)                                    as balance,
    round(sum(pr.interest) / 100.0, 2)                                 as interest,
    null::boolean                                                      as payment_plan,
    max(r.finished_at)                                                 as scraped_at
  from hmrc.ct_period pr
  join hmrc.run r          on r.id = pr.run_id
  join public.v_hmrc_ct_link lk on lk.ct_client_id = pr.client_id
  where pr.run_id = (select max(id) from hmrc.run where service = 'corporation-tax')
  group by lk.entity_id, lk.utr
),
vat as (
  select
    vc.entity_id, 'vat'::text as tax, vc.vrn as reference,
    round(sum(o.amount) / 100.0, 2)                                    as balance,
    null::numeric                                                      as interest,
    null::boolean                                                      as payment_plan,
    max(r.finished_at)                                                 as scraped_at
  from hmrc.vat_owed o
  join hmrc.run r        on r.id = o.run_id
  join hmrc.vat_client vc on vc.id = o.client_id
  where o.run_id = (select max(id) from hmrc.run where service = 'vat')
  group by vc.entity_id, vc.vrn
),
sa as (
  select distinct on (p.client_id)
    sc.entity_id, 'self-assessment'::text as tax, sc.utr as reference,
    round(p.total / 100.0, 2)      as balance,
    round(p.interest / 100.0, 2)   as interest,
    null::boolean                  as payment_plan,
    p.scraped_at
  from hmrc.sa_position p
  join hmrc.sa_client sc on sc.id = p.client_id
  order by p.client_id, p.scraped_at desc
),
all_tax as (
  select * from paye
  union all select * from ct
  union all select * from vat
  union all select * from sa
)
select
  t.entity_id,
  e.name          as entity_name,
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
  'One row per active client per tax head with the balance HMRC currently shows: PAYE from position.total_debt, Corporation Tax summed from ct_period.total, VAT summed from vat_owed, Self Assessment from sa_position (empty until SA is scraped). Amounts in POUNDS.';

revoke all on public.v_hmrc_client_tax_summary from public, anon;
grant select on public.v_hmrc_client_tax_summary to authenticated, service_role;

-- ── money in and out, across every tax ─────────────────────────────
-- Repayments HMRC sent the client, money the client paid, and credit moved from
-- one tax head to another. hmrc.money_movement already classifies CT and VAT but
-- carries CT's null entity_id and omits PAYE entirely; this repairs the entity
-- and adds PAYE so the picture is whole.
create or replace view public.v_hmrc_money_movements as
select
  lk.entity_id,
  t.client_name                as hmrc_name,
  'corporation-tax'::text      as tax,
  t.utr                        as reference,
  t.txn_date,
  t.movement,
  t.description,
  t.period_end::text           as period,
  round(t.amount / 100.0, 2)   as amount
from hmrc.ct_transfer t
join public.v_hmrc_ct_link lk on lk.utr = t.utr
where t.movement in ('from_another_tax', 'to_another_tax', 'cash_to_client', 'internal_ct')

union all
select
  vc.entity_id,
  vc.name,
  'vat'::text,
  vc.vrn,
  p.txn_date,
  case
    when p.kind in ('repayment', 'repayment_interest')        then 'cash_to_client'
    when p.kind = 'transfer' and p.direction = 'from_hmrc'    then 'from_another_tax'
    when p.kind = 'transfer'                                  then 'to_another_tax'
    when p.direction = 'to_hmrc'                              then 'paid_by_client'
    else 'other'
  end,
  p.description,
  coalesce(p.period_from::text, '') ||
    case when p.period_to is not null then ' to ' || p.period_to::text else '' end,
  round(p.amount / 100.0, 2)
from hmrc.vat_payment p
join hmrc.vat_client vc on vc.id = p.client_id
where p.run_id = (select max(id) from hmrc.run where service = 'vat')

union all
-- PAYE: money the client actually sent, from the latest scrape of each scheme.
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
  'Every movement of money between a client and HMRC across all tax heads: cash_to_client (repayments out), paid_by_client, and from_another_tax / to_another_tax / internal_ct (credit reallocated). Repairs the null entity_id on the CT side via v_hmrc_ct_link and adds PAYE, which hmrc.money_movement omits. Amounts in POUNDS.';

revoke all on public.v_hmrc_money_movements from public, anon;
grant select on public.v_hmrc_money_movements to authenticated, service_role;
