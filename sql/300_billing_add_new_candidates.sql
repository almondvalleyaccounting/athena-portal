-- 300: Fee Engine "Add new" badge — candidates counted server-side.
--
-- BillingTabs counted Add-new candidates with
--   entities?select=id,v_inferred_allocations!inner(canonical_service_id)
-- but a view has no foreign key to entities, so PostgREST can't detect a
-- relationship and answered HTTP 400 on every billing tab load. The badge
-- was always blank.
--
-- One row per candidate, same rule as BillingAddNewPage: an active
-- BrightManager entity with no QBO customer yet and at least one service
-- in the capacity planner (v_inferred_allocations). The badge does a
-- head/count against this, so nothing is counted in the browser.
--
-- security_invoker: entities and bm_task_schedule RLS apply as the caller.
-- Not readable by anon (new views pick up an anon grant from the schema's
-- default privileges, so revoke it explicitly).

create or replace view public.v_billing_add_new_candidates
with (security_invoker = true) as
select e.id as entity_id
from public.entities e
where e.entity_status = 'active'
  and e.source = 'brightmanager'
  and e.qbo_customer_id is null
  and exists (
    select 1 from public.v_inferred_allocations a where a.entity_id = e.id
  );

revoke all on public.v_billing_add_new_candidates from public, anon, authenticated;
grant select on public.v_billing_add_new_candidates to authenticated, service_role;
