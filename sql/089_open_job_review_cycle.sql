-- open_job_review_cycle(): create (or reuse) a monthly review cycle and
-- snapshot the current stalled cohort from ready_now_jobs into job_review_item.
-- Computes cross-cycle movement by comparing each job's BM status to the most
-- recent prior cycle. No emails — that's the notify edge function's job.
--
-- Callable by a portal admin from the app, or by the service role (cron).

-- Orders BM workflow statuses so we can tell "advanced" from "slipped".
create or replace function bm_status_rank(p text) returns int
language sql immutable as $$
  select case p
    when 'No Latest Action'             then 0
    when 'No Progress'                  then 0
    when 'Records Requested'            then 1
    when 'Part Records Received'        then 2
    when 'Records Received'             then 3
    when 'In Progress'                  then 4
    when 'Queries Requested'            then 5
    when 'Queries Received'             then 6
    when 'To Review'                    then 7
    when 'Reviewed'                     then 8
    when 'To Send to Client to Approve' then 9
    when 'Awaiting Approval'            then 10
    else -1
  end
$$;

drop function if exists open_job_review_cycle(date, uuid);

create or replace function open_job_review_cycle(
  p_period_month date default date_trunc('month', current_date)::date,
  p_actor        uuid default null
) returns table (out_cycle_id uuid, out_items_inserted int, out_total_items int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_cfg      job_review_config%rowtype;
  v_inserted int;
begin
  -- Allow service-role/cron (auth.uid() null) and staff with either admin flag.
  if auth.uid() is not null and not exists (
    select 1 from staff_profiles
    where id = auth.uid()
      and (coalesce(is_portal_admin, false) or coalesce(can_manage_portal, false))
  ) then
    raise exception 'not authorised to open a job-review cycle';
  end if;

  select * into v_cfg from job_review_config where id;

  insert into job_review_cycle (period_month, status, config_snapshot, opened_by)
  values (
    p_period_month, 'open',
    jsonb_build_object(
      'services', v_cfg.services,
      'boxes', v_cfg.boxes,
      'normal_min_days_past', v_cfg.normal_min_days_past
    ),
    coalesce(p_actor, auth.uid())
  )
  on conflict (period_month) do update set status = 'open'
  returning id into v_cycle_id;

  with cohort as (
    select rnj.*, rnj.assignee_ids[1] as primary_assignee
    from ready_now_jobs rnj
    where rnj.service = any(v_cfg.services)
      and rnj.box     = any(v_cfg.boxes)
  ),
  prev as (
    select distinct on (i.entity_id, i.service, i.period_end)
      i.entity_id, i.service, i.period_end, i.bm_status_snapshot
    from job_review_item i
    join job_review_cycle c on c.id = i.cycle_id
    where c.period_month < p_period_month
    order by i.entity_id, i.service, i.period_end, c.period_month desc
  ),
  ins as (
    insert into job_review_item (
      cycle_id, entity_id, service, period_end, client_name,
      assignee_id, assignee_ids, bm_status_snapshot, box, days_past,
      bm_deadline, bm_target_date, prev_bm_status, movement
    )
    select
      v_cycle_id, c.entity_id, c.service, c.period_end, c.client,
      c.primary_assignee, c.assignee_ids, c.bm_status, c.box, c.days_past,
      c.bm_deadline, c.bm_target_date,
      p.bm_status_snapshot,
      case
        when p.entity_id is null                                                  then 'new'
        when bm_status_rank(c.bm_status) > bm_status_rank(p.bm_status_snapshot)    then 'advanced'
        when bm_status_rank(c.bm_status) < bm_status_rank(p.bm_status_snapshot)    then 'slipped'
        else 'unchanged'
      end
    from cohort c
    left join prev p using (entity_id, service, period_end)
    on conflict (cycle_id, entity_id, service, period_end) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return query
    select v_cycle_id, v_inserted,
           (select count(*)::int from job_review_item where cycle_id = v_cycle_id);
end;
$$;

comment on function open_job_review_cycle(date, uuid) is
  'Creates/reuses the monthly job-review cycle for p_period_month and snapshots the stalled cohort (per job_review_config) from ready_now_jobs into job_review_item, tagging cross-cycle movement. No emails.';

grant execute on function open_job_review_cycle(date, uuid) to authenticated, service_role;
grant execute on function bm_status_rank(text) to authenticated, service_role;
