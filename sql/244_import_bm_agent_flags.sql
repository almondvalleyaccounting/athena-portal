-- 244: Feed the BrightManager leg of the onboarding cross-check.
--
-- The BM client export carries, per tax, whether we are the authorised agent.
-- The importer has never read those columns, so entities.bm_agent_* (sql/243)
-- has nothing in it and Cross-check shows "no data" for BrightManager.
--
-- Rather than rewrite the 6KB import_bm_clients, this is a side-load in the
-- same shape as import_bm_reviewers: the writer calls it straight after the
-- clients are in, so the bm_client_id lookup resolves.
--
-- The header wording is matched in the parser (a column qualifies when it names
-- both an authorisation and a tax) and the dry-run preview reports what it
-- matched — including, usefully, when it matched nothing.
--
-- The important rule is in the CASE statements: only a tax whose column was
-- present in the file is written. A missing column leaves its flag alone,
-- because "we didn't ask" must never end up reading as "not authorised".
create or replace function public.import_bm_agent_flags(run_id uuid, payload jsonb)
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
      bm_agent_seen_at = now(),
      updated_at = now()
    where e.bm_client_id = r->>'bm_client_id';

    if found then matched := matched + 1; end if;
  end loop;

  return jsonb_build_object('rows', seen, 'matched', matched);
end
$function$;

comment on function public.import_bm_agent_flags(uuid, jsonb) is 'Writes entities.bm_agent_* from the BrightManager client export''s agent-authorisation columns. Requires can_import_data. Only keys present in the payload are written, so a column absent from the export leaves its flag untouched.';

-- Gated internally on can_import_data / is_portal_admin, the same check
-- import_bm_clients makes. authenticated includes client-portal users, so the
-- internal check — not the grant — is what keeps them out.
revoke all on function public.import_bm_agent_flags(uuid, jsonb) from public;
revoke all on function public.import_bm_agent_flags(uuid, jsonb) from anon;
grant execute on function public.import_bm_agent_flags(uuid, jsonb) to authenticated, service_role;
