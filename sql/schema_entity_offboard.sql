-- ============================================================
-- Entity offboarding — "No longer a client" as one deliberate action.
--
-- Marking a client "no longer a client" from their client page:
--   * sets entity_status='nlac' (the established former-client status the
--     billing screens already respect / hide),
--   * cascades so they drop out of the operational views: open CH
--     personal-code requests are stalled (the CH pipeline hides stalled),
--     active onboardings are archived (List/Board hide archived),
--   * drops ONE task on Sophie's admin list to mirror the change in
--     BrightManager.
--
-- Silent verification: that admin task carries source='nlac_bm_mirror'. When
-- Sophie archives the client in BM they leave the next client export, so
-- their bm_client_id is absent from the upload — confirm_nlac_mirror_tasks()
-- (called from the BM client import) confirms the task and it drops off the
-- list. No manual tick needed; Athena and BM stay in step.
-- ============================================================

-- ── The action ──
create or replace function public.offboard_entity(p_entity_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ent    entities%rowtype;
  v_ch     int := 0;
  v_ob     int := 0;
  v_task_id uuid;
  v_actor  uuid := auth.uid();
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;
  select * into v_ent from entities where id = p_entity_id;
  if not found then raise exception 'entity % not found', p_entity_id; end if;

  update entities set entity_status = 'nlac', updated_at = now() where id = p_entity_id;

  -- Stall this client's open CH personal-code requests → they leave the pipeline.
  with upd as (
    update ch_code_requests
       set status = 'stalled', stage = 's7_rejected', updated_at = now()
     where entity_id = p_entity_id
       and stage not in ('s6_submitted','s7_rejected')
    returning id
  ), logged as (
    insert into ch_code_activity (request_id, kind, body, created_by)
    select id, 'system', 'Client marked no longer a client — request stalled.', v_actor from upd
    returning 1
  )
  select count(*) into v_ch from upd;

  -- Archive any in-flight onboardings → they leave List/Board.
  with upd as (
    update onboardings
       set archived_at = now()
     where entity_id = p_entity_id
       and archived_at is null
       and status in ('active','on_hold','issues')
    returning id
  ), logged as (
    insert into onboarding_activity (onboarding_id, kind, body, created_by)
    select id, 'system', 'Client marked no longer a client — onboarding archived.', v_actor from upd
    returning 1
  )
  select count(*) into v_ob from upd;

  -- Sophie's BM-mirror task — only when there's a BM record to mirror, and
  -- only one open at a time.
  if v_ent.bm_client_id is not null then
    if not exists (
      select 1 from admin_tasks
       where entity_id = p_entity_id and source = 'nlac_bm_mirror'
         and confirmed_at is null and dismissed_at is null
    ) then
      insert into admin_tasks (kind, entity_id, title, detail, source, created_by)
      values (
        'manual', p_entity_id,
        'Archive ' || v_ent.name || ' in BrightManager — no longer a client',
        coalesce(nullif('Reason: ' || coalesce(p_reason,''), 'Reason: '), 'Marked no longer a client in Athena.')
          || ' Confirms automatically when they drop from the next BrightManager client import.',
        'nlac_bm_mirror', v_actor
      )
      returning id into v_task_id;
    end if;
  end if;

  insert into audit_log (user_id, action, entity_type, entity_id, detail)
  values (v_actor, 'entity_offboarded', 'entity', p_entity_id,
          jsonb_build_object('reason', p_reason, 'ch_stalled', v_ch,
                             'onboardings_archived', v_ob, 'task_id', v_task_id,
                             'bm_client_id', v_ent.bm_client_id));

  return jsonb_build_object(
    'entity_id', p_entity_id, 'status', 'nlac',
    'ch_stalled', v_ch, 'onboardings_archived', v_ob,
    'bm_task_created', v_task_id is not null
  );
end;
$$;

-- ── Undo (reinstate) ──
-- Flips the client back to active and dismisses the open BM-mirror task.
-- Deliberately does NOT un-stall CH requests / un-archive onboardings —
-- re-onboarding is a fresh decision.
create or replace function public.reinstate_entity(p_entity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_actor uuid := auth.uid();
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;
  update entities set entity_status = 'active', updated_at = now() where id = p_entity_id;
  update admin_tasks set dismissed_at = now()
   where entity_id = p_entity_id and source = 'nlac_bm_mirror'
     and confirmed_at is null and dismissed_at is null;
  insert into audit_log (user_id, action, entity_type, entity_id, detail)
  values (v_actor, 'entity_reinstated', 'entity', p_entity_id, jsonb_build_object('status','active'));
end;
$$;

-- ── Silent verification on BM re-import ──
-- Confirms open nlac_bm_mirror tasks whose entity has dropped from the
-- uploaded BM client export (its bm_client_id is not in the set), i.e. Sophie
-- has archived them in BrightManager. Called from the BM client import writer.
create or replace function public.confirm_nlac_mirror_tasks(p_bm_client_ids text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;
  with upd as (
    update admin_tasks t
       set confirmed_at = now()
      from entities e
     where t.entity_id = e.id
       and t.source = 'nlac_bm_mirror'
       and t.confirmed_at is null and t.dismissed_at is null
       and e.bm_client_id is not null
       and not (e.bm_client_id = any (coalesce(p_bm_client_ids, array[]::text[])))
    returning t.id
  )
  select count(*) into v_n from upd;
  return v_n;
end;
$$;

grant execute on function public.offboard_entity(uuid, text) to authenticated;
grant execute on function public.reinstate_entity(uuid) to authenticated;
grant execute on function public.confirm_nlac_mirror_tasks(text[]) to authenticated;
