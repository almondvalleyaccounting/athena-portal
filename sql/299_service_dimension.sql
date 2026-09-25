-- 299 — One service dimension for management information.
--
-- Three vocabularies name the same work, and every money table stores one of
-- them:
--
--   fee engine    'payroll'                  quote_line_items, entity_fees,
--                                             standard_fees
--   ad-hoc label  'Payroll'                  billing_items (one-off bills)
--   QBO full name 'Payroll Related:Payroll'  live_billing.services[] (pulled
--                                             from the recurring templates)
--
-- They are deliberately separate lists (one-off work is not recurring work),
-- but they meet at the QuickBooks product: qbo_service_items maps both the
-- fee-engine ids (is_adhoc = false) and the ad-hoc labels (is_adhoc = true)
-- to a qbo_item_id, and qbo_items gives that product its full name.
--
-- v_service_dimension turns that into one row per key any of those tables
-- can hold, resolved to one reporting service (the QBO product) and its
-- category. Join any money table on its service key and group by
-- reporting_service / reporting_category, and quotes, recurring fees and
-- one-off bills consolidate.
--
-- It holds no mapping of its own — it reads qbo_service_items and qbo_items —
-- so there is nothing extra to maintain: map a service on the Products page
-- and it appears here.
--
-- Known granularity at product level (decided 2026-09-25, report by product):
-- VAT Returns sits inside Bookkeeping (VAT Registered), Auto-Enrolment inside
-- Payroll, and the two software services share Software.
--
-- v_service_dimension_gaps lists every key actually in use in a money table
-- that does not resolve, with how often it appears — the lines MI would drop.
--
-- Both views are security_invoker: they read as the caller, so the base
-- tables' RLS applies (qbo_* are staff-readable; live_billing, entity_fees
-- and quote_line_items keep their fee gating).

create or replace view public.v_service_dimension
with (security_invoker = true) as
with keys as (
  -- fee-engine ids and ad-hoc labels, from the one map
  select
    s.service_id                                        as service_key,
    case when s.is_adhoc then 'adhoc' else 'fee_engine' end as key_kind,
    s.qbo_item_id::text                                 as qbo_item_id,
    case when s.is_adhoc then null else s.service_id end as fee_engine_service_id,
    1 + (case when s.is_adhoc then 1 else 0 end)        as priority
  from public.qbo_service_items s
  where s.service_id is not null and s.qbo_item_id is not null
  union all
  -- the QBO full name, as live_billing stores it
  select i.fully_qualified_name, 'qbo_full_name', i.qbo_item_id::text, null, 3
  from public.qbo_items i
  where i.fully_qualified_name is not null
  union all
  -- the bare QBO name, which older manual rows carry
  select i.name, 'qbo_name', i.qbo_item_id::text, null, 4
  from public.qbo_items i
  where i.name is not null
),
resolved as (
  -- One row per key. Where a key appears under more than one kind (the
  -- ad-hoc label 'Payroll' is also the bare QBO name) the kinds agree on the
  -- product; the lowest priority wins for fee_engine_service_id.
  select distinct on (service_key)
    service_key, qbo_item_id, fee_engine_service_id
  from keys
  order by service_key, priority
),
kinds as (
  select service_key, array_agg(distinct key_kind order by key_kind) as key_kinds
  from keys group by service_key
),
category as (
  -- A product's category, from the map (sql/189), else the first segment of
  -- its QBO full name.
  select i.qbo_item_id::text as qbo_item_id,
         coalesce(
           (select s.qbo_category from public.qbo_service_items s
             where s.qbo_item_id::text = i.qbo_item_id::text and s.qbo_category is not null
             order by s.is_adhoc limit 1),
           nullif(split_part(i.fully_qualified_name, ':', 1), i.fully_qualified_name),
           'Other') as reporting_category
  from public.qbo_items i
)
select
  r.service_key,
  k.key_kinds,
  r.fee_engine_service_id,
  r.qbo_item_id,
  i.name                  as reporting_service,
  c.reporting_category,
  i.fully_qualified_name  as qbo_full_name,
  i.active                as qbo_item_active
from resolved r
join kinds k using (service_key)
join public.qbo_items i on i.qbo_item_id::text = r.qbo_item_id
left join category c on c.qbo_item_id = r.qbo_item_id;

comment on view public.v_service_dimension is
  'One row per service key used by any money table (fee-engine id, ad-hoc label, QBO full or bare name), resolved to its QBO product as the reporting service. See sql/299.';

create or replace view public.v_service_dimension_gaps
with (security_invoker = true) as
with used as (
  select s->>'service_id' as service_key, 'live_billing' as source
  from public.live_billing lb, jsonb_array_elements(coalesce(lb.services, '[]'::jsonb)) s
  where lb.status = 'active'
  union all
  -- A one-off bill's top-level service is a summary label ("Payroll +2
  -- more") when it has several lines; the real service is on each line.
  select l->>'service', 'billing_items'
  from public.billing_items bi,
       jsonb_array_elements(case when jsonb_typeof(bi.lines) = 'array' then bi.lines else '[]'::jsonb end) l
  union all
  select bi.service, 'billing_items' from public.billing_items bi
  where coalesce(jsonb_typeof(bi.lines), '') <> 'array' or bi.lines = '[]'::jsonb
  union all
  select q.service_id, 'quote_line_items' from public.quote_line_items q
  union all
  select ef.service_id, 'entity_fees' from public.entity_fees ef
  union all
  select sf.service_id, 'standard_fees' from public.standard_fees sf
)
select u.service_key, u.source, count(*) as uses
from used u
where u.service_key is not null
  and not exists (select 1 from public.v_service_dimension d where d.service_key = u.service_key)
group by u.service_key, u.source;

comment on view public.v_service_dimension_gaps is
  'Service keys in use in a money table that v_service_dimension cannot resolve to a QBO product — lines MI would drop. See sql/299.';

-- A new view is granted to anon by the schema default privileges; neither
-- view is for anyone but signed-in staff and the service role.
-- The same default hands authenticated every privilege, not just SELECT.
revoke all on public.v_service_dimension, public.v_service_dimension_gaps from public, anon, authenticated;
grant select on public.v_service_dimension, public.v_service_dimension_gaps to authenticated, service_role;

-- Verified 2026-09-25 by impersonation: a portal client reads 0 rows from
-- both; active staff read 139 keys and 17 unresolved keys in use.
