-- ============================================================
-- CH personal-code reconciliation on BM import (Stage 5).
--
-- v2 (14/07): the code must reach the person who HOLDS THE CHASE, not just the
-- BM primary contact. Root cause of the Iraj Ali mismatch — the same human
-- exists as separate people rows (a BrightManager primary-contact record AND
-- Companies-House officer/PSC records with the full legal name). CH-code
-- requests are seeded on the officer/PSC records; BM codes were landing on the
-- contact record so the chase never closed. reconcile_ch_codes now matches the
-- primary contact's first+last name to the officer/PSC request-holder(s) on
-- the entity, lands the code, marks entered_bm and moves the request to Stage 5;
-- a differing existing code raises bm_code_mismatch; falls back to the primary
-- contact if there's no chase. Masked codes ('*') are ignored.
--
-- v3 (15/07): also auto-clears "fix the code in BM" data-error to-dos
-- (admin_tasks.source='bm_data_error', bad value stored in .value) once a
-- valid, CHANGED code arrives for that client on a later import — the tester
-- so Sophie's BM correction drops the to-do automatically.
--
-- NOTE ON CODE FORMAT: for this client base the genuine CH personal codes all
-- end "-2223" (confirmed by Bobby against the BM export) — that is NOT a
-- redaction. Real codes were sourced from the BM client export column
-- "Companies House Personal Code" (primary + "Secondary …").
-- ============================================================

create or replace function public.reconcile_ch_codes(p_pairs jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  rec record; e_id uuid; pc_first text; pc_last text; pc_person uuid;
  q record; v_landed int := 0; v_closed int := 0; v_flagged int := 0; v_errors_cleared int := 0; v_targeted boolean;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;

  for rec in select * from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as x(bm_client_id text, code text)
  loop
    if rec.code is null or btrim(rec.code) = '' or rec.code like '%*%' then continue; end if;

    select id into e_id from entities where bm_client_id = rec.bm_client_id;
    if e_id is null then continue; end if;

    -- Tester: clear a BM data-error to-do once a valid, changed code arrives.
    update admin_tasks t set confirmed_at = now(), bm_value = btrim(rec.code)
     where t.entity_id = e_id and t.source = 'bm_data_error'
       and t.confirmed_at is null and t.dismissed_at is null
       and btrim(rec.code) ~ '^[A-Za-z0-9]{3}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$'
       and _norm_code(rec.code) <> _norm_code(coalesce(t.value,''));
    if found then v_errors_cleared := v_errors_cleared + 1; end if;

    select ep.person_id, lower(split_part(p.name,' ',1)), lower(regexp_replace(p.name,'^.* ',''))
      into pc_person, pc_first, pc_last
      from entity_people ep join people p on p.id = ep.person_id
      where ep.entity_id = e_id and ep.is_primary_contact limit 1;

    v_targeted := false;

    for q in
      select r.id as req_id, r.person_id, r.stage, p.ch_personal_code, p.name
      from ch_code_requests r
      join people p on p.id = r.person_id
      join entity_people ep on ep.person_id = p.id and ep.entity_id = e_id
      where r.entity_id = e_id and r.stage not in ('s6_submitted','s7_rejected')
        and ( ep.is_primary_contact
           or ( pc_first is not null
                and lower(split_part(p.name,' ',1)) = pc_first
                and lower(regexp_replace(p.name,'^.* ','')) = pc_last ) )
    loop
      v_targeted := true;
      if coalesce(q.ch_personal_code,'') = '' or q.ch_personal_code like '%*%'
         or _norm_code(q.ch_personal_code) = _norm_code(rec.code) then
        update people set ch_personal_code = btrim(rec.code) where id = q.person_id;
        update ch_code_requests set stage = 's5_entered', status = 'code_received',
               entered_bm_at = now(), bm_code_mismatch = null,
               emails_sent = 0, escalation_status = 'none', escalated_at = null, called_at = null, updated_at = now()
          where id = q.req_id;
        insert into ch_code_activity (request_id, kind, body)
          values (q.req_id, 'status_change', 'Personal code ' || btrim(rec.code) || ' found on BrightManager — code received & entered (Stage 5).');
        v_landed := v_landed + 1; v_closed := v_closed + 1;
      else
        update ch_code_requests set bm_code_mismatch = btrim(rec.code) where id = q.req_id;
        v_flagged := v_flagged + 1;
      end if;
    end loop;

    if not v_targeted and pc_person is not null then
      update people set ch_personal_code = btrim(rec.code)
        where id = pc_person and (coalesce(ch_personal_code,'') = '' or ch_personal_code like '%*%');
      v_landed := v_landed + 1;
    end if;
  end loop;

  return jsonb_build_object('codes_landed', v_landed, 'chases_closed', v_closed, 'flagged', v_flagged, 'bm_errors_cleared', v_errors_cleared);
end;
$$;

grant execute on function public.reconcile_ch_codes(jsonb) to authenticated;
