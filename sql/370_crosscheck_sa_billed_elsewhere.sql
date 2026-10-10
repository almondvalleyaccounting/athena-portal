-- ============================================================
-- 370 — Cross-check: SA billed inside another client's fee
--
-- Bobby (2026-10-10): SA is mixed — some billed annually, some inside other
-- billing (e.g. the company's bill). Annual SA invoices already reach
-- live_billing through qbo-pull's 12-month invoice inference, so an
-- individual still flagged had no SA invoice under their own QBO customer in
-- a year. Two refinements:
--
--   * Billed elsewhere, provably: the person is linked (any current role, not
--     only director) to another client whose fee names SA / tax returns /
--     all-inclusive. Counts as billed — sql/368's director rule, widened.
--   * Billed elsewhere, possibly: linked to another client that is billed
--     but whose fee doesn't name SA. Still flagged (it may not be covered),
--     but sa_linked_billed names those clients so the modal can say where to
--     look, and the override is one comment.
-- ============================================================

create or replace view public.v_onboarding_crosscheck_billing_missing
with (security_invoker = true) as
with sa_fee as (
  select distinct lb.entity_id
  from public.live_billing lb
  cross join lateral jsonb_array_elements(lb.services) s(value)
  where coalesce(lb.status, '') <> 'cancelled'
    and (s.value ->> 'service_id') ~* 'tax returns|self assessment|personal tax|all inclusive'
),
any_fee as (
  select distinct entity_id from public.live_billing where coalesce(status, '') <> 'cancelled'
),
linked as (
  select distinct me.entity_id, o.entity_id as other_id
  from public.entity_people me
  join public.entity_people o
    on o.person_id = me.person_id and o.entity_id <> me.entity_id and o.ended_on is null
  where me.ended_on is null
),
missing as (
  select x.entity_id, x.tax
  from public.v_onboarding_crosscheck x
  where x.is_scheduled
    and not x.is_billed
    and not (x.tax = 'sa' and (
          exists (select 1 from public.v_onboarding_crosscheck_director_sa d
                  where d.director_entity_id = x.entity_id)
       or exists (select 1 from linked l join sa_fee f on f.entity_id = l.other_id
                  where l.entity_id = x.entity_id)))
)
select m.entity_id,
       string_agg(m.tax, ', ' order by m.tax) as billing_missing_taxes,
       case when bool_or(m.tax = 'sa') then (
         select string_agg(distinct e.name, ', ')
           from linked l
           join any_fee f on f.entity_id = l.other_id
           join public.entities e on e.id = l.other_id
          where l.entity_id = m.entity_id) end as sa_linked_billed
from missing m
where public.is_staff_or_service()
group by m.entity_id;

comment on view public.v_onboarding_crosscheck_billing_missing is
  'Per client, the taxes scheduled in BrightManager that no live fee-engine line bills. SA counts as billed when the person is linked to another client whose fee names SA. sa_linked_billed: other billed clients the person is linked to, where SA may be bundled. Feeds the Cross-check Billing mark.';

revoke all on public.v_onboarding_crosscheck_billing_missing from public, anon, authenticated;
grant select on public.v_onboarding_crosscheck_billing_missing to authenticated, service_role;
