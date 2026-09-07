-- 279 — reconcile_ch_codes logs a landing once, not on every import
--
-- The weekly CH-code email printed the same line six times for one person:
--
--   Personal code XRH-Y2T9-2223 found on BrightManager - code received &
--   entered (Stage 5).   × 6
--
-- Two independent multipliers, both here:
--
-- 1. RE-LOGGING. The landing branch fires when the stored code already equals
--    BM's code. A request that landed weeks ago sits at s5_entered, which the
--    loop does not exclude (only s6/s7 are), so every BM import re-stamped
--    entered_bm_at, reset the counters, and inserted a fresh activity row for
--    a code that had not changed. 45 open requests were at s5, so every import
--    minted 45 identical "code received" rows.
--
-- 2. FAN-OUT. The loop joins entity_people. There are 700 duplicate
--    (entity_id, person_id) links, so a person linked to their client three
--    times yields the same request three times in one pass — three identical
--    inserts at the same microsecond. The duplicate links are a data-quality
--    problem of their own; this changes the join to `exists` so the reconciler
--    cannot be multiplied by them either way.
--
-- The fix is idempotence: a code that is already stored, on a request already
-- at s5, is a no-op. Nothing to update, nothing to log, nothing counted.
--
-- Only the landing branch changes. Mismatch flagging, the by-reference person
-- match, the primary-contact fallback and the admin-task auto-clears all
-- behave exactly as before.

create or replace function public.reconcile_ch_codes(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record; e_id uuid; pc_first text; pc_last text; pc_person uuid;
  q record; v_landed int := 0; v_closed int := 0; v_flagged int := 0; v_errors_cleared int := 0; v_targeted boolean;
  v_by_ref boolean; v_unchanged int := 0;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;

  for rec in select * from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb))
             as x(bm_client_id text, code text, person_ref text)
  loop
    if rec.code is null or btrim(rec.code) = '' or rec.code like '%*%' then continue; end if;

    select id into e_id from entities where bm_client_id = rec.bm_client_id;
    if e_id is null then continue; end if;

    -- Auto-clear a "fix the code in BM" data-error to-do once a valid, changed
    -- code arrives for this client (the tester: Sophie's fix shows up next import).
    update admin_tasks t set confirmed_at = now(), bm_value = btrim(rec.code)
     where t.entity_id = e_id and t.source = 'bm_data_error'
       and t.confirmed_at is null and t.dismissed_at is null
       and btrim(rec.code) ~ '^[A-Za-z0-9]{3}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$'
       and _norm_code(rec.code) <> _norm_code(coalesce(t.value,''));
    if found then v_errors_cleared := v_errors_cleared + 1; end if;

    -- Confirm "add personal code to BM" to-dos once BM's export carries the
    -- matching code for this client (silent verification for the Completed tab).
    update admin_tasks t set confirmed_at = now(), done_at = coalesce(t.done_at, now())
     where t.entity_id = e_id and t.kind = 'bm_code' and t.field = 'ch_personal_code'
       and t.confirmed_at is null and t.dismissed_at is null
       and (t.reopened_at is null or t.done_at is not null)
       and _norm_code(coalesce(t.value,'')) = _norm_code(rec.code);

    -- Whose code is this? An exact person reference beats every heuristic.
    -- Without one the old route stands: the primary contact, or anyone on
    -- this client sharing their first and last name - which for the two
    -- David Boyds, father and son and both contacts of the same two
    -- companies, matches either man.
    pc_person := null; v_by_ref := false;
    if nullif(btrim(coalesce(rec.person_ref, '')), '') is not null then
      select ep.person_id into pc_person
        from entity_people ep join people p on p.id = ep.person_id
       where ep.entity_id = e_id and p.bm_person_ref = btrim(rec.person_ref)
       limit 1;
      if pc_person is not null then v_by_ref := true; end if;
    end if;

    if pc_person is null then
      select ep.person_id into pc_person
        from entity_people ep
        where ep.entity_id = e_id and ep.is_primary_contact limit 1;
    end if;

    select lower(split_part(p.name,' ',1)), lower(regexp_replace(p.name,'^.* ',''))
      into pc_first, pc_last
      from people p where p.id = pc_person;

    v_targeted := false;

    -- `exists` rather than a join: 700 duplicate entity_people links would
    -- otherwise yield the same request two or three times in one pass.
    for q in
      select r.id as req_id, r.person_id, r.stage, p.ch_personal_code, p.name
      from ch_code_requests r
      join people p on p.id = r.person_id
      where r.entity_id = e_id and r.stage not in ('s6_submitted','s7_rejected')
        and exists (
          select 1 from entity_people ep
           where ep.person_id = p.id and ep.entity_id = e_id
             and ( v_by_ref or ep.is_primary_contact
                   or ( pc_first is not null
                        and lower(split_part(p.name,' ',1)) = pc_first
                        and lower(regexp_replace(p.name,'^.* ','')) = pc_last ) )
        )
        and ( not v_by_ref or r.person_id = pc_person )
    loop
      v_targeted := true;

      -- Already landed, code unchanged: nothing happened. Do not re-stamp,
      -- do not log, do not count. This is the line that used to reappear in
      -- the weekly email every single import.
      if q.stage = 's5_entered'
         and _norm_code(coalesce(q.ch_personal_code,'')) = _norm_code(rec.code) then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;

      if coalesce(q.ch_personal_code,'') = '' or q.ch_personal_code like '%*%'
         or _norm_code(q.ch_personal_code) = _norm_code(rec.code) then
        update people set ch_personal_code = btrim(rec.code) where id = q.person_id;
        update ch_code_requests set stage = 's5_entered', status = 'code_received',
               entered_bm_at = now(), bm_code_mismatch = null,
               emails_sent = 0, escalation_status = 'none', escalated_at = null, called_at = null, updated_at = now()
          where id = q.req_id;
        insert into ch_code_activity (request_id, kind, body)
          values (q.req_id, 'status_change', 'Personal code ' || btrim(rec.code) || ' found on BrightManager - code received & entered (Stage 5).');
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

  return jsonb_build_object('codes_landed', v_landed, 'chases_closed', v_closed,
                            'flagged', v_flagged, 'bm_errors_cleared', v_errors_cleared,
                            'already_landed', v_unchanged);
end $$;

-- Grants: staff and service_role only. The function guards itself with
-- is_active_staff(), but a new function is EXECUTE-able by anon under the
-- schema default privilege, so the revoke is not optional.
revoke all on function public.reconcile_ch_codes(jsonb) from public;
grant execute on function public.reconcile_ch_codes(jsonb) to authenticated, service_role;
