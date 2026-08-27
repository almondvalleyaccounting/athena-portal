-- ============================================================
-- A comment nobody is told about is a comment nobody reads.
--
-- Sophie has been writing progress notes on admin tasks since July — "email
-- sent to Gerald to sign the strike-off application", "still no reply" — and
-- nobody outside her own screen ever saw one. The thread existed
-- (admin_task_notes, sql/108) and the notifications spine existed (sql/110),
-- but nothing joined them: no trigger, no digest, and on the list page the
-- thread sits collapsed behind a small speech-bubble inside a section that
-- defaults collapsed. Three clicks from a fresh load, if you knew to look.
--
-- So a note now notifies whoever has a stake in the task:
--   * whoever raised it (created_by),
--   * whoever it was escalated to,
--   * anyone already talking on the thread,
-- minus the author, who does not need telling what they just wrote.
--
-- When that set is empty the note still reaches someone. 18 of 72 admin tasks
-- have no creator — they came in from the workplan import (sql/118), which is
-- exactly where Sophie's notes live — and a note on one of those would
-- otherwise notify nobody at all. Those fall back to the three people who own
-- this list (can_manage_task_pipeline: Bobby, Tracy, Yvonne). That is a
-- deliberate, small fallback, not a full-team blast.
--
-- Escalation notes are skipped: admin-task-escalate already emails the person
-- it hands the task to, and telling them twice trains them to ignore both.
-- ============================================================

create or replace function public.admin_task_note_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author  text;
  v_title   text;
  v_client  text;
  v_head    text;
  v_count   int;
begin
  -- The escalation edge function sends its own email. Don't double up.
  if new.kind = 'escalation' then
    return new;
  end if;

  select sp.name into v_author from staff_profiles sp where sp.id = new.author_id;

  select t.title, e.name
    into v_title, v_client
    from admin_tasks t
    left join entities e on e.id = t.entity_id
   where t.id = new.task_id;

  v_head := coalesce(v_author, 'A colleague') || ' commented on '
         || coalesce(nullif(v_client, ''), 'an admin task');

  -- Everyone with a stake in this task, author excluded.
  with stake as (
    select t.created_by as id from admin_tasks t where t.id = new.task_id
    union
    select t.escalated_to from admin_tasks t where t.id = new.task_id
    union
    select n.author_id from admin_task_notes n
     where n.task_id = new.task_id and n.id <> new.id
  ),
  recipients as (
    select sp.id
      from stake s
      join staff_profiles sp on sp.id = s.id
     where sp.is_active is not false
       and (new.author_id is null or sp.id <> new.author_id)
  )
  insert into notifications (recipient_id, kind, title, body, link_path, source_key)
  select r.id, 'admin_task_comment', v_head,
         coalesce(nullif(v_title, ''), 'Admin task') || ' — ' || left(new.body, 200),
         '/planner/tasks/' || new.task_id::text,
         'atn:' || new.id::text
    from recipients r
  on conflict (recipient_id, source_key) where source_key is not null do nothing;

  get diagnostics v_count = row_count;

  -- Nobody with a stake: the imported tasks. Tell the list's owners.
  if v_count = 0 then
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    select sp.id, 'admin_task_comment', v_head,
           coalesce(nullif(v_title, ''), 'Admin task') || ' — ' || left(new.body, 200),
           '/planner/tasks/' || new.task_id::text,
           'atn:' || new.id::text
      from staff_profiles sp
     where sp.can_manage_task_pipeline
       and sp.is_active is not false
       and (new.author_id is null or sp.id <> new.author_id)
    on conflict (recipient_id, source_key) where source_key is not null do nothing;
  end if;

  return new;
end;
$$;

comment on function public.admin_task_note_notify() is
  'Notifies the task creator, escalation target and existing thread participants '
  'when a note is added — falling back to can_manage_task_pipeline holders when a '
  'task has no creator (workplan imports). Author is never notified of their own note.';

-- A newly created function holds EXECUTE for PUBLIC, which checks D and F of
-- the posture audit both flag. A trigger function needs EXECUTE only at
-- CREATE TRIGGER time, so the revoke costs nothing at fire time.
revoke execute on function public.admin_task_note_notify() from public, anon, authenticated;
grant execute on function public.admin_task_note_notify() to service_role;

drop trigger if exists admin_task_note_notify on public.admin_task_notes;
create trigger admin_task_note_notify
  after insert on public.admin_task_notes
  for each row execute function public.admin_task_note_notify();
