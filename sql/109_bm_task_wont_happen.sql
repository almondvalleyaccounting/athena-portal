-- 109: "Won't happen" triage for BM jobs — zombie late-work exclusion.
--
-- The home "open jobs late" panel (and digest, Ready Now, job review) counted
-- jobs that will never be done (a P11D 1,904 days late, setup tasks from
-- defunct onboardings, accounts for struck-off companies). An owner can now
-- mark a planned job "won't happen": it leaves every count immediately, and
-- the BM cleanup lands on Sophie's admin list — auto-confirmed when the job
-- leaves the BM export (the import sweep flips vanished rows to
-- state='completed'; rows are UPDATEd on re-import so the exclusion sticks).
-- Nothing is deleted; BrightManager remains the record.

alter table bm_task_schedule
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by uuid references staff_profiles(id),
  add column if not exists excluded_reason text;

-- Owners only. Takes bm_task_schedule PKs; one admin task per job for Sophie,
-- keyed by bm_task_id in admin_tasks.detail (text column).
create or replace function public.mark_bm_tasks_wont_happen(p_ids uuid[], p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $function$
declare r record; marked int := 0; tasks_created int := 0; sophie uuid;
begin
  if not coalesce((select can_manage_portal from staff_profiles where id = auth.uid()), false) then
    raise exception 'forbidden: can_manage_portal required';
  end if;
  select id into sophie from staff_profiles where name = 'Sophie Laidlaw' limit 1;

  for r in
    select s.id, s.bm_task_id, s.bm_task_name, s.entity_id, e.name as entity_name
    from bm_task_schedule s
    left join entities e on e.id = s.entity_id
    where s.id = any(p_ids) and s.state = 'planned' and s.excluded_at is null
  loop
    update bm_task_schedule
       set excluded_at = now(), excluded_by = auth.uid(), excluded_reason = p_reason
     where id = r.id;
    marked := marked + 1;

    insert into admin_tasks (kind, source, entity_id, title, detail, created_by)
    values (
      'manual', 'bm_task_wont_happen', r.entity_id,
      format('Cancel "%s" for %s in BrightManager — marked won''t happen in Athena%s',
             r.bm_task_name, coalesce(r.entity_name, 'unknown client'),
             case when p_reason is not null and p_reason <> '' then ' (' || p_reason || ')' else '' end),
      r.bm_task_id,
      auth.uid()
    );
    tasks_created := tasks_created + 1;

    insert into audit_log (user_id, action, entity_type, entity_id, detail)
    values (auth.uid(), 'bm_task_wont_happen', 'bm_task_schedule', r.id,
            jsonb_build_object('bm_task_id', r.bm_task_id, 'bm_task_name', r.bm_task_name,
                               'entity_id', r.entity_id, 'reason', p_reason));
  end loop;

  return jsonb_build_object('marked', marked, 'admin_tasks_created', tasks_created);
end $function$;

-- Undo: clears the exclusion and dismisses the open admin task.
create or replace function public.unmark_bm_task_wont_happen(p_id uuid)
returns void
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_bm_task_id text;
begin
  if not coalesce((select can_manage_portal from staff_profiles where id = auth.uid()), false) then
    raise exception 'forbidden: can_manage_portal required';
  end if;
  select bm_task_id into v_bm_task_id from bm_task_schedule where id = p_id;
  update bm_task_schedule
     set excluded_at = null, excluded_by = null, excluded_reason = null
   where id = p_id;
  update admin_tasks set dismissed_at = now()
   where source = 'bm_task_wont_happen' and detail = v_bm_task_id
     and confirmed_at is null and dismissed_at is null;
end $function$;

-- Silent verification after each BM tasks import: once the job is no longer
-- planned (the sweep completed it because it left the export), Sophie's
-- cleanup task confirms itself. Mirrors confirm_nlac_mirror_tasks.
create or replace function public.confirm_wont_happen_tasks()
returns integer
language plpgsql security definer
set search_path to 'public'
as $function$
declare n int;
begin
  update admin_tasks t
     set confirmed_at = now()
   where t.source = 'bm_task_wont_happen'
     and t.confirmed_at is null and t.dismissed_at is null
     and not exists (
       select 1 from bm_task_schedule s
       where s.bm_task_id = t.detail and s.state = 'planned'
     );
  get diagnostics n = row_count;
  return n;
end $function$;

-- Ready Now (and the job-review cohort it feeds) must not include excluded
-- jobs — recreated with the one extra condition.
create or replace view public.ready_now_jobs as
 WITH derived AS (
         SELECT b.entity_id,
            b.service,
            derive_period_end(b.service, b.bm_deadline, b.bm_task_name) AS period_end,
            b.bm_deadline,
            b.bm_target_date,
            b.bm_status,
            b.assignee_id,
            b.bm_task_id
           FROM bm_task_schedule b
          WHERE b.state = 'planned'::text
            AND b.excluded_at IS NULL
            AND (b.service = ANY (ARRAY['Annual Accounts'::text, 'Self Assessment'::text]))
        ), valid AS (
         SELECT derived.entity_id,
            derived.service,
            derived.period_end,
            derived.bm_deadline,
            derived.bm_target_date,
            derived.bm_status,
            derived.assignee_id,
            derived.bm_task_id
           FROM derived
          WHERE derived.period_end IS NOT NULL
        ), rep AS (
         SELECT DISTINCT ON (valid.entity_id, valid.service, valid.period_end) valid.entity_id,
            valid.service,
            valid.period_end,
            valid.bm_deadline,
            valid.bm_target_date,
            valid.bm_status
           FROM valid
          ORDER BY valid.entity_id, valid.service, valid.period_end, valid.bm_target_date, valid.bm_deadline, valid.bm_task_id
        ), agg AS (
         SELECT v.entity_id,
            v.service,
            v.period_end,
            array_remove(array_agg(DISTINCT v.assignee_id), NULL::uuid) AS assignee_ids,
            array_remove(array_agg(DISTINCT sp.name), NULL::text) AS assignee_names
           FROM valid v
             LEFT JOIN staff_profiles sp ON sp.id = v.assignee_id
          GROUP BY v.entity_id, v.service, v.period_end
        )
 SELECT r.entity_id,
    e.name AS client,
    e.grade,
    r.service,
    r.period_end,
    r.bm_deadline,
    r.bm_target_date,
    r.bm_status,
    a.assignee_ids,
    a.assignee_names,
    COALESCE(e.expedite, false) AS expedite,
    e.deprioritise_reason,
    CURRENT_DATE - r.period_end AS days_past,
        CASE
            WHEN r.bm_deadline IS NOT NULL THEN r.bm_deadline - CURRENT_DATE
            ELSE NULL::integer
        END AS days_to_deadline,
        CASE
            WHEN e.deprioritise_reason IS NOT NULL THEN 'deprioritised'::text
            WHEN r.bm_deadline IS NOT NULL AND (r.bm_deadline - CURRENT_DATE) <= 14 THEN 'urgent'::text
            WHEN COALESCE(e.expedite, false) AND (CURRENT_DATE - r.period_end) >= 0 THEN 'expedite'::text
            WHEN (CURRENT_DATE - r.period_end) >= 90 THEN 'normal'::text
            ELSE 'upcoming'::text
        END AS box
   FROM rep r
     JOIN agg a USING (entity_id, service, period_end)
     JOIN entities e ON e.id = r.entity_id;
