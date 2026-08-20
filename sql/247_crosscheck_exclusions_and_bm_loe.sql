-- 247: Two cross-check corrections from the first read-through.
--
-- 1. "Not VAT Registered" matched the VAT rule.
--    The billing rule for VAT was the pattern 'vat', which also matches
--    "All Inclusive Fees - Ltd Companies (Not VAT Registered)" and
--    "Bookkeeping (non-VAT registered)". Ten clients were credited with a VAT
--    service on the strength of a product name that says the opposite, and
--    nine of them had no other VAT product at all — so they were being asked
--    for a VAT authorisation they should never need.
--
--    Exclusions are now data, not code: rules carry an exclude_pattern, which
--    also absorbs the Modulr exception that used to be hardcoded in the view
--    (Modulr is a payment rail bought alongside payroll, not payroll).
--
--    Note this does NOT excuse 17 Degrees Magazine: they are billed
--    "Bookkeeping (VAT Registered)" and "Monthly Bookkeeping & VAT Returns"
--    with no VAT number on record. That flag is the billing data disagreeing
--    with reality, which is the point of the module.
--
-- 2. The engagement letter is recorded in BrightManager too.
--    Anchor Gas Services has a signed date in BM while Athena's "Letter of
--    Engagement signed and returned" step still reads pending — so the client
--    was flagged for a letter that exists. Athena's step is not the only
--    record of the truth, and the cross-check should not pretend it is.
--
--    entities.loe_signed_date takes BM's date, detected in the BM export the
--    same way the agent columns are, and the view treats either record as
--    evidence. Where only BM has it, loe_from_bm_only says so — that is an
--    Athena-is-stale finding, not a chase-the-client one.

-- ── Exclusions as data ───────────────────────────────────────────────────
alter table onboarding_crosscheck_service_rules
  add column if not exists exclude_pattern text;
comment on column onboarding_crosscheck_service_rules.exclude_pattern is 'Case-insensitive regex that disqualifies a service even when pattern matches — e.g. "Not VAT Registered" must not count as a VAT service.';

update onboarding_crosscheck_service_rules
   set exclude_pattern = 'non.?vat|not vat'
 where source = 'billing' and tax = 'vat';

update onboarding_crosscheck_service_rules
   set exclude_pattern = 'modulr'
 where source = 'billing' and tax = 'paye';

-- ── BrightManager's engagement-letter date ───────────────────────────────
alter table entities
  add column if not exists loe_signed_date date;
comment on column entities.loe_signed_date is 'Engagement-letter signed date as recorded in BrightManager, read from the client export. null = the export had no such column, or BM has no date — not evidence that no letter was signed.';

-- The side-load now covers both sets of columns the main importer never reads,
-- so it is no longer only about agent flags. Same contract: a key absent from
-- the payload leaves its column untouched, because "we didn't ask" must never
-- read as "no".
drop function if exists public.import_bm_agent_flags(uuid, jsonb);

create or replace function public.import_bm_side_fields(run_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  seen int := 0;
  matched int := 0;
begin
  if not (coalesce(is_portal_admin(), false)
          or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)) then
    raise exception 'forbidden: can_import_data required';
  end if;
  if not exists (select 1 from import_log where id = run_id and status = 'running') then
    raise exception 'import_log % not in running status', run_id;
  end if;

  for r in select * from jsonb_array_elements(payload->'rows') loop
    if nullif(r->>'bm_client_id', '') is null then continue; end if;
    seen := seen + 1;

    update entities e set
      bm_agent_sa   = case when r ? 'bm_agent_sa'   then (r->>'bm_agent_sa')::boolean   else e.bm_agent_sa   end,
      bm_agent_ct   = case when r ? 'bm_agent_ct'   then (r->>'bm_agent_ct')::boolean   else e.bm_agent_ct   end,
      bm_agent_vat  = case when r ? 'bm_agent_vat'  then (r->>'bm_agent_vat')::boolean  else e.bm_agent_vat  end,
      bm_agent_paye = case when r ? 'bm_agent_paye' then (r->>'bm_agent_paye')::boolean else e.bm_agent_paye end,
      bm_agent_cis  = case when r ? 'bm_agent_cis'  then (r->>'bm_agent_cis')::boolean  else e.bm_agent_cis  end,
      bm_agent_seen_at = case
        when r ? 'bm_agent_sa' or r ? 'bm_agent_ct' or r ? 'bm_agent_vat'
          or r ? 'bm_agent_paye' or r ? 'bm_agent_cis' then now()
        else e.bm_agent_seen_at end,
      loe_signed_date = case when r ? 'loe_signed_date'
                             then nullif(r->>'loe_signed_date','')::date
                             else e.loe_signed_date end,
      updated_at = now()
    where e.bm_client_id = r->>'bm_client_id';

    if found then matched := matched + 1; end if;
  end loop;

  return jsonb_build_object('rows', seen, 'matched', matched);
end
$function$;

comment on function public.import_bm_side_fields(uuid, jsonb) is 'Writes the BrightManager client-export columns the main importer does not read: entities.bm_agent_* and entities.loe_signed_date. Requires can_import_data. Only keys present in the payload are written, so a column absent from the export leaves its value untouched.';

revoke all on function public.import_bm_side_fields(uuid, jsonb) from public;
revoke all on function public.import_bm_side_fields(uuid, jsonb) from anon;
grant execute on function public.import_bm_side_fields(uuid, jsonb) to authenticated, service_role;
