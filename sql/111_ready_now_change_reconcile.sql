-- ============================================================
-- Ready Now change-request queue → self-heal on BM re-import.
--
-- ready_now_change_requests (sql/076) queues Grade/BM Target/Assignee edits
-- made in the Ready Now view. Today nothing ever auto-resolves a pending
-- row — an admin must manually click "Mark applied" in the Changes Queue,
-- even after BM's data genuinely catches up. This adds:
--   1. reconcile_ready_now_change_requests() — for every pending
--      field='bm_target' request, compares proposed_value against the
--      live BM target date (ready_now_jobs, sql/087, itself derived from
--      bm_task_schedule). If they now match, marks the request 'applied'
--      automatically. No match (or no live job) leaves it pending — same
--      "only resolve on positive evidence" convention as
--      reconcile_allocation_changes (sql/110) and reconcile_field_overrides.
--   2. Wires that into import_bm_tasks, right after reconcile_allocation_
--      changes(), so it runs on every BM tasks import.
-- ============================================================

create or replace function public.reconcile_ready_now_change_requests()
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cr record;
  bm_target date;
  resolved int := 0;
begin
  for cr in
    select id, entity_id, service, period_end, proposed_value
    from ready_now_change_requests
    where status = 'pending' and field = 'bm_target'
  loop
    begin
      bm_target := null;
      select rnj.bm_target_date into bm_target
      from ready_now_jobs rnj
      where rnj.entity_id = cr.entity_id
        and rnj.service = cr.service
        and rnj.period_end is not distinct from cr.period_end;

      if bm_target is not null and cr.proposed_value is not null
         and bm_target = cr.proposed_value::date then
        update ready_now_change_requests
        set status = 'applied', applied_at = now()
        where id = cr.id;
        resolved := resolved + 1;
      end if;
    exception when others then
      -- An unparseable proposed_value shouldn't block the rest of the queue.
      continue;
    end;
  end loop;
  return resolved;
end;
$function$;

comment on function public.reconcile_ready_now_change_requests() is
  'Auto-marks a pending bm_target ready_now_change_requests row "applied" once BrightManager''s target date (via ready_now_jobs) actually matches the proposed date. Called from import_bm_tasks after every BM tasks import, and from the Ready Now view on page load.';

-- ── import_bm_tasks: add the second reconciler call, alongside
--    reconcile_allocation_changes(). Full function body required for
--    CREATE OR REPLACE — only change vs sql/110's version is the
--    counter_ready_now_resolved variable/call and its count in the
--    returned jsonb.
create or replace function public.import_bm_tasks(run_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  row_input jsonb; errs jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
  counter_scheduled int := 0; counter_updated int := 0; counter_overridden_skipped int := 0;
  counter_f_no_rule int := 0; counter_f_entity int := 0; counter_f_no_time int := 0;
  counter_f_under int := 0; counter_f_deadline int := 0; counter_f_completed int := 0;
  counter_realloc_reverted int := 0; counter_ready_now_resolved int := 0;
  bm_task_id_val text; bm_task_name_val text; entity_id_val uuid; entity_name_val text;
  assignee_id_val uuid; assignee_name_raw text; rule public.bm_scheduling_rules;
  deadline_d date; target_d date; latest_action_d date;
  scheduled_d date; scheduled_hrs numeric(5,2); existing public.bm_task_schedule;
  actual_minutes int; expected_hours numeric(5,2);
  seen_ids text[]; cancelled_row record;
begin
  if not (coalesce(is_portal_admin(), false) or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)) then
    raise exception 'forbidden: can_import_data required';
  end if;
  if not exists (select 1 from import_log where id = run_id and status = 'running') then
    raise exception 'import_log % not in running status', run_id;
  end if;

  for row_input in select * from jsonb_array_elements(payload->'rows') loop
    begin
      bm_task_id_val := nullif(row_input->>'bm_task_id', '');
      bm_task_name_val := nullif(row_input->>'bm_task_name', '');
      assignee_name_raw := nullif(trim(row_input->>'assignee_name'), '');

      if bm_task_id_val is null or bm_task_name_val is null then
        skipped := skipped || jsonb_build_object('bm_task_id', bm_task_id_val, 'reason', 'missing bm_task_id or bm_task_name');
        continue;
      end if;

      entity_id_val := null; entity_name_val := null;
      if nullif(row_input->>'client_reference', '') is not null then
        select id, name into entity_id_val, entity_name_val from entities where bm_client_id = row_input->>'client_reference' limit 1;
      end if;
      if entity_id_val is null then
        insert into bm_reconciliation_flags (bm_task_id, flag_type, severity, import_id, details) values (
          bm_task_id_val, 'entity_not_found', 'warn', run_id,
          jsonb_build_object('client_reference', row_input->>'client_reference', 'client_name', row_input->>'client_name', 'bm_task_name', bm_task_name_val)
        );
        counter_f_entity := counter_f_entity + 1;
        continue;
      end if;

      assignee_id_val := resolve_bm_assignee(assignee_name_raw);
      deadline_d := parse_bm_date(row_input->>'deadline');
      target_d := parse_bm_date(row_input->>'target_date');
      latest_action_d := parse_bm_date(row_input->>'latest_action_date');

      rule := match_bm_rule(bm_task_name_val);
      if rule.id is null then
        insert into bm_reconciliation_flags (bm_task_id, flag_type, severity, import_id, details) values (
          bm_task_id_val, 'no_rule_match', 'warn', run_id,
          jsonb_build_object('bm_task_name', bm_task_name_val, 'entity_name', entity_name_val, 'assignee', assignee_name_raw)
        );
        counter_f_no_rule := counter_f_no_rule + 1;
        continue;
      end if;

      scheduled_d := compute_bm_schedule_date(rule.lead_time_days, rule.preferred_dow, rule.preferred_week_of_month, deadline_d, target_d);
      scheduled_hrs := rule.standard_hours;

      select * into existing from bm_task_schedule where bm_task_id = bm_task_id_val;

      if existing.id is null then
        insert into bm_task_schedule (
          bm_task_id, entity_id, rule_id, bm_task_name, service,
          bm_deadline, bm_target_date, bm_status, bm_latest_action_date,
          assignee_id, bm_assignee_name, scheduled_for_date, scheduled_hours,
          state, last_import_id, last_seen_at
        ) values (
          bm_task_id_val, entity_id_val, rule.id, bm_task_name_val, rule.service,
          deadline_d, target_d, nullif(row_input->>'task_progress',''), latest_action_d,
          coalesce(assignee_id_val, case when rule.assignee_source = 'rule_assignee' then rule.rule_assignee_id end),
          assignee_name_raw, scheduled_d, scheduled_hrs, 'planned', run_id, now()
        );
        counter_scheduled := counter_scheduled + 1;
      else
        if existing.manually_overridden_at is not null and deadline_d is distinct from existing.bm_deadline then
          insert into bm_reconciliation_flags (bm_task_id, flag_type, severity, import_id, details) values (
            bm_task_id_val, 'deadline_moved', 'warn', run_id,
            jsonb_build_object('old_deadline', existing.bm_deadline, 'new_deadline', deadline_d, 'scheduled_for_date', existing.scheduled_for_date)
          );
          counter_f_deadline := counter_f_deadline + 1;
        end if;

        update bm_task_schedule set
          entity_id = entity_id_val, rule_id = rule.id, bm_task_name = bm_task_name_val, service = rule.service,
          bm_deadline = deadline_d, bm_target_date = target_d,
          bm_status = nullif(row_input->>'task_progress',''), bm_latest_action_date = latest_action_d,
          assignee_id = coalesce(assignee_id_val, case when rule.assignee_source = 'rule_assignee' then rule.rule_assignee_id end),
          bm_assignee_name = assignee_name_raw,
          scheduled_for_date = case when manually_overridden_at is null then scheduled_d else scheduled_for_date end,
          scheduled_hours = case when manually_overridden_at is null then scheduled_hrs else scheduled_hours end,
          state = case when state = 'cancelled' then 'planned' when state = 'completed' then 'planned' else state end,
          last_import_id = run_id, last_seen_at = now()
        where bm_task_id = bm_task_id_val;

        if existing.manually_overridden_at is not null then counter_overridden_skipped := counter_overridden_skipped + 1;
        else counter_updated := counter_updated + 1;
        end if;
      end if;

    exception when others then
      errs := errs || jsonb_build_object('bm_task_id', bm_task_id_val, 'message', sqlerrm);
    end;
  end loop;

  -- Disappearance = completion sweep
  select array(select jsonb_array_elements_text(coalesce(payload->'seen_task_ids', '[]'::jsonb))) into seen_ids;
  if seen_ids is not null and array_length(seen_ids, 1) > 0 then
    for cancelled_row in
      select id, bm_task_id, bm_task_name, state, scheduled_for_date, scheduled_hours, entity_id, service
      from bm_task_schedule
      where not (bm_task_id = any(seen_ids)) and state = 'planned'
    loop
      select coalesce(sum(minutes), 0) into actual_minutes from timesheet_entries where source_task_id = cancelled_row.id;
      expected_hours := cancelled_row.scheduled_hours;

      if actual_minutes = 0 then
        insert into bm_reconciliation_flags (bm_task_id, flag_type, severity, import_id, details) values (
          cancelled_row.bm_task_id, 'completed_no_time', 'warn', run_id,
          jsonb_build_object('bm_task_name', cancelled_row.bm_task_name, 'expected_hours', expected_hours,
                             'scheduled_for_date', cancelled_row.scheduled_for_date,
                             'entity_id', cancelled_row.entity_id, 'service', cancelled_row.service)
        );
        counter_f_no_time := counter_f_no_time + 1;
      elsif (actual_minutes::numeric / 60) < (expected_hours - 1) then
        insert into bm_reconciliation_flags (bm_task_id, flag_type, severity, import_id, details) values (
          cancelled_row.bm_task_id, 'completed_under_expected', 'warn', run_id,
          jsonb_build_object('bm_task_name', cancelled_row.bm_task_name, 'expected_hours', expected_hours,
                             'actual_hours', round(actual_minutes::numeric / 60, 2),
                             'shortfall_hours', round(expected_hours - (actual_minutes::numeric / 60), 2),
                             'entity_id', cancelled_row.entity_id, 'service', cancelled_row.service)
        );
        counter_f_under := counter_f_under + 1;
      end if;

      update bm_task_schedule set state = 'completed', last_import_id = run_id, last_seen_at = now() where id = cancelled_row.id;
      counter_f_completed := counter_f_completed + 1;
    end loop;
  end if;

  counter_realloc_reverted := reconcile_allocation_changes();
  counter_ready_now_resolved := reconcile_ready_now_change_requests();

  return jsonb_build_object(
    'scheduled', counter_scheduled, 'updated', counter_updated,
    'overridden_skipped', counter_overridden_skipped,
    'tasks_completed', counter_f_completed,
    'reallocations_reverted', counter_realloc_reverted,
    'ready_now_resolved', counter_ready_now_resolved,
    'flags', jsonb_build_object(
      'no_rule_match', counter_f_no_rule, 'entity_not_found', counter_f_entity,
      'completed_no_time', counter_f_no_time, 'completed_under_expected', counter_f_under,
      'deadline_moved', counter_f_deadline
    ),
    'errors', errs, 'skipped', skipped
  );
end $function$;
