-- 240: Drafting a task (and the £0 bill that hangs off it) needs no extra rights.
--
-- 137 put the 'draft' stage behind can_manage_task_pipeline, on both select and
-- insert. That flag is held by three people (Bobby/Tracy/Yvonne), so everyone
-- else hit "new row violates row-level security policy" the moment they tried to
-- park a task as a draft — which is exactly what you do when the work is done
-- but the fee isn't settled yet, i.e. the £0 placeholder bill.
--
-- The £0 bill itself was never the problem: billing_items already lets anyone
-- with can_view_billing insert a draft at any amount, £0 included. Only the
-- admin_tasks draft stage blocked it.
--
-- Drafting is not a managerial act — it is "I'm not ready to put this on the
-- live list". Admin tasks are a shared workspace, so drafts stay visible to all
-- active staff rather than to their author alone; a draft only one person can
-- see is a draft nobody picks up.
--
-- can_manage_task_pipeline still gates what it should: the stage dropdown and
-- the manual Billed → To Do release (release_admin_task, untouched here).

drop policy if exists "admin_tasks_select" on public.admin_tasks;
create policy "admin_tasks_select" on public.admin_tasks for select
  using (is_active_staff());

drop policy if exists "admin_tasks_insert" on public.admin_tasks;
create policy "admin_tasks_insert" on public.admin_tasks for insert
  with check (is_active_staff());
