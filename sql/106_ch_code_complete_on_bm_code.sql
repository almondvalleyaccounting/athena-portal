-- ============================================================
-- CH personal code — complete & remove from the chase pipeline once BM holds
-- the code. Supersedes the Stage-5-only reconcile in schema_ch_code_bm_reconcile.
--
-- The personal code is PER PERSON and reusable across their companies. BM's
-- client export carries ONE code per client (company), so routing it to a
-- director is only unambiguous when a company has a single director in the
-- pipeline. Rules per (bm_client_id, code):
--   * single open request for that company → land the code on that director
--     (if we don't already hold it); if BM's code differs from one we hold,
--     flag bm_code_mismatch and leave for manual reconcile.
--   * multiple open requests (several directors) → can't attribute one code;
--     leave a one-off note on each and skip (Sophie handles manually).
-- Then, unambiguously at the PERSON level: any open request whose person holds
-- a code is identity-verified → mark complete (Stage 6, submitted) and drop it
-- off the chase board. Inert on clients with no code in the export.
-- ============================================================

create or replace function public.reconcile_ch_codes(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec         record;
  v_entity    uuid;
  v_open_cnt  int;
  v_person    uuid;
  v_existing  text;
  v_landed    int := 0;
  v_completed int := 0;
  v_flagged   int := 0;
  v_ambiguous int := 0;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;

  for rec in select * from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as x(bm_client_id text, code text)
  loop
    if rec.code is null or btrim(rec.code) = '' then continue; end if;

    select id into v_entity from entities where bm_client_id = rec.bm_client_id limit 1;
    if v_entity is null then continue; end if;

    select count(*) into v_open_cnt from ch_code_requests
      where entity_id = v_entity and stage not in ('s6_submitted', 's7_rejected');

    if v_open_cnt = 1 then
      select person_id into v_person from ch_code_requests
        where entity_id = v_entity and stage not in ('s6_submitted', 's7_rejected') limit 1;
      select ch_personal_code into v_existing from people where id = v_person;

      if v_existing is null or btrim(v_existing) = '' then
        update people set ch_personal_code = btrim(rec.code) where id = v_person;
        v_landed := v_landed + 1;
      elsif regexp_replace(lower(v_existing), '[^a-z0-9]', '', 'g')
            <> regexp_replace(lower(rec.code), '[^a-z0-9]', '', 'g') then
        update ch_code_requests set bm_code_mismatch = btrim(rec.code), updated_at = now()
          where entity_id = v_entity and stage not in ('s6_submitted', 's7_rejected');
        insert into ch_code_activity (request_id, kind, body)
          select id, 'system',
                 'BM shows a different personal code (' || btrim(rec.code) || ') than recorded (' || v_existing || ') — please reconcile.'
            from ch_code_requests where entity_id = v_entity and stage not in ('s6_submitted', 's7_rejected');
        v_flagged := v_flagged + 1;
      end if;

    elsif v_open_cnt > 1 then
      v_ambiguous := v_ambiguous + 1;
      insert into ch_code_activity (request_id, kind, body)
        select r.id, 'system',
               'BrightManager holds a personal code for this company, but multiple directors are still in the pipeline — cannot tell which director it belongs to. Please confirm manually.'
          from ch_code_requests r
         where r.entity_id = v_entity and r.stage not in ('s6_submitted', 's7_rejected')
           and not exists (
             select 1 from ch_code_activity a
              where a.request_id = r.id
                and a.body like 'BrightManager holds a personal code for this company, but multiple directors%');
    end if;
  end loop;

  -- Person-level completion (unambiguous): a recorded code = identity verified.
  with upd as (
    update ch_code_requests r
       set stage = 's6_submitted', status = 'entered_on_bm',
           entered_bm_at = coalesce(r.entered_bm_at, now()),
           submitted_at = coalesce(r.submitted_at, now()),
           escalation_status = 'none', updated_at = now()
      from people p
     where p.id = r.person_id
       and r.stage not in ('s6_submitted', 's7_rejected')
       and p.ch_personal_code is not null and btrim(p.ch_personal_code) <> ''
       and coalesce(r.bm_code_mismatch, '') = ''
    returning r.id
  )
  insert into ch_code_activity (request_id, kind, body)
    select id, 'status_change',
           'Marked complete — CH personal code recorded in BrightManager (identity verified); removed from the chase pipeline.'
      from upd;
  get diagnostics v_completed = row_count;

  return jsonb_build_object('landed', v_landed, 'completed', v_completed, 'flagged', v_flagged, 'ambiguous', v_ambiguous);
end;
$$;

grant execute on function public.reconcile_ch_codes(jsonb) to authenticated;

-- ── One-time: complete anyone who ALREADY holds a code but is still open. ──
with upd as (
  update ch_code_requests r
     set stage = 's6_submitted', status = 'entered_on_bm',
         entered_bm_at = coalesce(r.entered_bm_at, now()),
         submitted_at = coalesce(r.submitted_at, now()),
         escalation_status = 'none', updated_at = now()
    from people p
   where p.id = r.person_id
     and r.stage not in ('s6_submitted', 's7_rejected')
     and p.ch_personal_code is not null and btrim(p.ch_personal_code) <> ''
     and coalesce(r.bm_code_mismatch, '') = ''
  returning r.id
)
insert into ch_code_activity (request_id, kind, body)
  select id, 'status_change',
         'Marked complete — CH personal code already recorded (identity verified); removed from the chase pipeline.'
    from upd;
