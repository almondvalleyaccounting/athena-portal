-- 271: a one-off is not an annual
--
-- qbo-pull infers a service's cadence from how often it appears in twelve
-- months of invoices. A service seen in the latest month and the one before is
-- monthly; a service seen only once is treated as ANNUAL and divided by twelve.
--
-- A one-off and an annual are indistinguishable under that test — both appear
-- exactly once. So registering a client for PAYE once, at £50, became £4.17 a
-- month of recurring revenue for ever. Worse, an inferred monthly is written as
-- 'suggested' and waits for a human, while an inferred annual is auto-approved
-- as system:annual_default. Nobody was ever asked.
--
-- Found 2026-08-28 on 191 Architecture, whose £1,705 "annual" included a £50
-- one-off PAYE registration. Across the firm it was 37 service lines and about
-- £267 a month — roughly £3.2k a year of revenue that does not exist.
--
-- Two halves, because either alone leaves the hole open:
--   1. Name the services that are one-off by nature, so they are never spread.
--   2. Stop auto-approving a single-occurrence inference at all (in qbo-pull),
--      so the next one-off nobody has thought of waits for a human instead of
--      quietly entering the run rate.
--
-- This file is half 1, plus the repair of what is already in the data.

-- ---------------------------------------------------------------------------
-- 1. The flag. On qbo_items because that is the catalogue qbo-pull already
--    mirrors from QuickBooks, and service_id in live_billing.services IS the
--    QBO item's fully-qualified name — so this is a lookup, not a new mapping
--    to keep in step. Staff can flag a new one-off without a deploy.
--
--    qbo-pull's upsert names its columns explicitly and does not include this
--    one, so a nightly pull cannot reset it.
-- ---------------------------------------------------------------------------
alter table public.qbo_items
  add column if not exists is_one_off boolean not null default false;

comment on column public.qbo_items.is_one_off is
  'Billed once per occurrence, never recurring — excluded from run-rate figures and never spread over 12 months by qbo-pull''s cadence inference. See sql/271.';

update public.qbo_items
   set is_one_off = true
 where fully_qualified_name in (
   'Company Secretarial:Company Formation',      -- you form a company once
   'Company Secretarial:HMRC Registrations',     -- PAYE/VAT registration, once
   'Company Secretarial:ID Verification',        -- CH personal code, once per person
   'Company Secretarial:Companies House Amendments', -- ad hoc, not on a cycle
   'Advisory:Billable Hours'                     -- ad hoc by definition
 );

-- ---------------------------------------------------------------------------
-- 2. Repair what is already recorded.
--
-- Scoped to fee-engine inferred rows (quote_id is null): a committed row's
-- totals come from the quote the client actually agreed, not from this
-- inference, and must not be recomputed from its services array.
--
-- The line is kept rather than deleted — it is a true record that the work was
-- billed — but it stops contributing to the recurring figures, and carries
-- what it actually was in one_off_amount.
-- ---------------------------------------------------------------------------
with one_off_names as (
  select fully_qualified_name as fqn from public.qbo_items where is_one_off
),
affected as (
  select lb.id
  from public.live_billing lb, jsonb_array_elements(lb.services) s
  where lb.status = 'active'
    and lb.quote_id is null
    and s->>'service_id' in (select fqn from one_off_names)
  group by lb.id
),
rewritten as (
  select lb.id,
         jsonb_agg(
           case
             when s.value->>'service_id' in (select fqn from one_off_names)
             then s.value || jsonb_build_object(
                    'cadence',        'one_off',
                    'cadence_months', null,
                    'monthly_amount', 0,
                    'annual_amount',  0,
                    'one_off_amount', coalesce((s.value->>'annual_amount')::numeric, 0),
                    'one_off_reclassified_at', to_jsonb(now()),
                    'review_reason',  'Reclassified as one-off (sql/271) — was being spread over 12 months'
                  )
             else s.value
           end
           order by s.ord
         ) as services
  from public.live_billing lb
  join affected a on a.id = lb.id,
       jsonb_array_elements(lb.services) with ordinality s(value, ord)
  group by lb.id
)
update public.live_billing lb
   set services   = r.services,
       updated_at = now()
  from rewritten r
 where lb.id = r.id;

-- Recompute the row totals from the rewritten services. Same scope, and the
-- same arithmetic the engine uses: annual_total and monthly_net are NET sums,
-- VAT is a flat 20%.
with one_off_names as (
  select fully_qualified_name as fqn from public.qbo_items where is_one_off
),
affected as (
  select lb.id
  from public.live_billing lb, jsonb_array_elements(lb.services) s
  where lb.status = 'active'
    and lb.quote_id is null
    and s->>'service_id' in (select fqn from one_off_names)
  group by lb.id
),
totals as (
  select lb.id,
         round(sum(coalesce((s->>'monthly_amount')::numeric, 0)), 2) as mn,
         round(sum(coalesce((s->>'annual_amount')::numeric, 0)), 2)  as at
  from public.live_billing lb
  join affected a on a.id = lb.id,
       jsonb_array_elements(lb.services) s
  group by lb.id
)
update public.live_billing lb
   set monthly_net   = t.mn,
       monthly_vat   = round(t.mn * 0.20, 2),
       monthly_gross = round(t.mn * 1.20, 2),
       annual_total  = t.at,
       updated_at    = now()
  from totals t
 where lb.id = t.id;
