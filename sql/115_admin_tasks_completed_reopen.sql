-- ============================================================
-- Admin task list: completed tasks leave the open list.
-- Completing a task now moves it to a Completed tab instead of striking it
-- through in place; BM still verifies it silently on the next import.
--
-- reopened_at supports "move back to open": without it, reopening a task
-- whose value BM already holds would be silently re-confirmed (and vanish
-- back to Completed) on the very next page load, because
-- admin_tasks_confirm_from_bm() matches on the entity field. A reopened
-- task stays under manual control until it is completed again (done_at
-- set), at which point BM auto-confirm resumes.
--
-- Applied as migration admin_tasks_completed_reopen (16/07/2026).
-- ============================================================

alter table admin_tasks add column if not exists reopened_at timestamptz;
comment on column admin_tasks.reopened_at is
  'Set when a completed task is moved back to open. Suppresses BM auto-confirm until the task is completed again (done_at present).';

create or replace function admin_tasks_confirm_from_bm()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n int := 0;
  t record;
  entity_val text;
begin
  for t in
    select a.id, a.entity_id, a.field, a.value from admin_tasks a
     where a.kind = 'bm_code' and a.field is not null
       and a.confirmed_at is null and a.dismissed_at is null
       -- a reopened task stays open until it is manually completed again
       and (a.reopened_at is null or a.done_at is not null)
  loop
    execute format('select %I from entities where id = $1', t.field) into entity_val using t.entity_id;
    if entity_val is not null and (
         t.value is null
         or regexp_replace(lower(entity_val), '[^a-z0-9]', '', 'g') = regexp_replace(lower(t.value), '[^a-z0-9]', '', 'g')
       ) then
      update admin_tasks set confirmed_at = now(), done_at = coalesce(done_at, now()) where id = t.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
