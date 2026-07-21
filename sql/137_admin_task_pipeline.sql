-- 137: Admin-task pipeline — Draft → Bill & Hold → Billed → To Do.
--
-- Stages:
--   draft     — being drafted; NOT on the live list; visible only to pipeline
--               managers (can_manage_task_pipeline).
--   bill_hold — a bill needs raising; the linked billing_items row is created
--               into the Billing Module (accept/send) — task waits here.
--   billed    — (derived in the UI from the linked bill being pushed) invoice
--               raised & pushed; held until paid OR manually released.
--   todo      — live / actionable (the default; every existing task lands here).
--
-- Manual release Billed → To Do is restricted to can_manage_task_pipeline
-- (Bobby/Tracy/Yvonne, managed in Admin → Staff). Auto-release once the QBO
-- invoice is marked paid is a later follow-up (match on invoice number).

-- ── Access flag ─────────────────────────────────────────────────────
alter table public.staff_profiles
  add column if not exists can_manage_task_pipeline boolean not null default false;

update public.staff_profiles set can_manage_task_pipeline = true
 where email in (
   'bobby@almondvalleyaccounting.co.uk',
   'tracy@almondvalleyaccounting.co.uk',
   'yvonne@almondvalleyaccounting.co.uk'
 );

create or replace function public.can_manage_task_pipeline()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and is_active and can_manage_task_pipeline
  );
$$;
grant execute on function public.can_manage_task_pipeline() to authenticated;

-- ── Stage + release audit columns ───────────────────────────────────
alter table public.admin_tasks
  add column if not exists stage text not null default 'todo',
  add column if not exists released_at timestamptz,
  add column if not exists released_by uuid references public.staff_profiles(id);

do $$ begin
  alter table public.admin_tasks
    add constraint admin_tasks_stage_chk check (stage in ('draft','bill_hold','billed','todo'));
exception when duplicate_object then null; end $$;

-- ── RLS: drafts are visible/insertable only to pipeline managers ─────
drop policy if exists "admin_tasks_staff" on public.admin_tasks;

drop policy if exists "admin_tasks_select" on public.admin_tasks;
create policy "admin_tasks_select" on public.admin_tasks for select
  using (is_active_staff() and (stage <> 'draft' or public.can_manage_task_pipeline()));

drop policy if exists "admin_tasks_insert" on public.admin_tasks;
create policy "admin_tasks_insert" on public.admin_tasks for insert
  with check (is_active_staff() and (stage <> 'draft' or public.can_manage_task_pipeline()));

drop policy if exists "admin_tasks_update" on public.admin_tasks;
create policy "admin_tasks_update" on public.admin_tasks for update
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists "admin_tasks_delete" on public.admin_tasks;
create policy "admin_tasks_delete" on public.admin_tasks for delete
  using (is_active_staff());

-- ── Gated release Billed/Bill&Hold → To Do ──────────────────────────
create or replace function public.release_admin_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_task_pipeline() then
    raise exception 'forbidden: task-pipeline managers only';
  end if;
  update admin_tasks
     set stage = 'todo', released_at = now(), released_by = auth.uid()
   where id = p_task_id and stage in ('bill_hold','billed');
end $$;
grant execute on function public.release_admin_task(uuid) to authenticated;
