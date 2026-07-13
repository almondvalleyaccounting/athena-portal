-- ============================================================
-- CH personal-code — BM reconciliation on import (Stage 5).
-- The personal code is per-director and isn't in today's BM client export.
-- Once it is (user is adding it), the BM import calls reconcile_ch_codes()
-- with {bm_client_id, code} pairs. For each client's PRIMARY CONTACT person
-- with a request at Stage 5 (s5_entered):
--   * code missing on our side → land it (BM as source of truth) + mark BM ✓
--   * code matches (normalised)  → mark entered_bm_at, clear any mismatch flag
--   * code differs               → set bm_code_mismatch + log, so staff reconcile
-- Inert until codes actually appear in the import.
-- ============================================================

create or replace function public.reconcile_ch_codes(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec         record;
  v_person    uuid;
  v_existing  text;
  v_landed    int := 0;
  v_confirmed int := 0;
  v_flagged   int := 0;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;

  for rec in select * from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as x(bm_client_id text, code text)
  loop
    if rec.code is null or btrim(rec.code) = '' then continue; end if;

    select ep.person_id into v_person
      from entities e
      join entity_people ep on ep.entity_id = e.id and ep.is_primary_contact
     where e.bm_client_id = rec.bm_client_id
     limit 1;
    if v_person is null then continue; end if;

    select ch_personal_code into v_existing from people where id = v_person;

    if v_existing is null then
      update people set ch_personal_code = btrim(rec.code) where id = v_person;
      update ch_code_requests set entered_bm_at = now(), bm_code_mismatch = null, updated_at = now()
        where person_id = v_person and stage = 's5_entered';
      v_landed := v_landed + 1;
    elsif regexp_replace(lower(v_existing), '[^a-z0-9]', '', 'g') = regexp_replace(lower(rec.code), '[^a-z0-9]', '', 'g') then
      update ch_code_requests set entered_bm_at = now(), bm_code_mismatch = null, updated_at = now()
        where person_id = v_person and stage = 's5_entered';
      v_confirmed := v_confirmed + 1;
    else
      update ch_code_requests set bm_code_mismatch = btrim(rec.code), updated_at = now()
        where person_id = v_person and stage = 's5_entered';
      insert into ch_code_activity (request_id, kind, body)
        select id, 'system',
               'BM import shows a different personal code (' || btrim(rec.code) || ') than recorded (' || v_existing || ') — please reconcile.'
          from ch_code_requests where person_id = v_person and stage = 's5_entered';
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  return jsonb_build_object('landed', v_landed, 'confirmed', v_confirmed, 'flagged', v_flagged);
end;
$$;

grant execute on function public.reconcile_ch_codes(jsonb) to authenticated;
