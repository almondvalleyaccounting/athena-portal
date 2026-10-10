-- ============================================================
-- 368 — Cross-check: "Billing missing"
--
-- The Cross-check now reads in three finding types (Bobby, 2026-10-10):
--   Agent missing   — a reference (PAYE / VAT / UTR) is on record but the client
--                     is not on HMRC's agent list
--   Code missing    — the service is on but the reference is not in BM yet
--   Billing missing — a BM service is scheduled but nothing bills it
--
-- "Nothing bills it" means no live fee-engine line (live_billing, which mirrors
-- the QBO recurring templates) for that service. Two corrections so the type
-- starts honest rather than noisy:
--   * VAT had no billing rule at all, so every VAT client read as unbilled. VAT
--     is billed inside bookkeeping / all-inclusive ("… (VAT Registered)",
--     "Bookkeeping & VAT Returns").
--   * A director's Self Assessment is often billed on their company's fee. If
--     the person is a director of a company whose fee covers directors' SA
--     (v_onboarding_crosscheck_director_sa), it is billed.
-- Anything else billed elsewhere (another company in the group) is a person's
-- call: overridden on the screen with a comment (sql/367).
-- ============================================================

insert into public.onboarding_crosscheck_service_rules (source, tax, pattern, exclude_pattern, note)
select 'billing', 'vat', 'vat registered|vat returns', 'non.?vat|not vat',
       'VAT is billed inside bookkeeping / all-inclusive, not as its own line (sql/368)'
where not exists (
  select 1 from public.onboarding_crosscheck_service_rules
  where source = 'billing' and tax = 'vat' and pattern = 'vat registered|vat returns'
);

create or replace view public.v_onboarding_crosscheck_billing_missing
with (security_invoker = true) as
select x.entity_id,
       string_agg(x.tax, ', ' order by x.tax) as billing_missing_taxes
from public.v_onboarding_crosscheck x
where x.is_scheduled
  and not x.is_billed
  and not (x.tax = 'sa' and exists (
        select 1 from public.v_onboarding_crosscheck_director_sa d
        where d.director_entity_id = x.entity_id))
  and public.is_staff_or_service()
group by x.entity_id;

comment on view public.v_onboarding_crosscheck_billing_missing is
  'Per client, the taxes scheduled in BrightManager that no live fee-engine line bills. Directors'' SA billed through their company counts as billed. Feeds the Cross-check "Billing missing" type.';

revoke all on public.v_onboarding_crosscheck_billing_missing from public, anon, authenticated;
grant select on public.v_onboarding_crosscheck_billing_missing to authenticated, service_role;
