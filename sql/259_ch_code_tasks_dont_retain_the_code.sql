-- 259 — A finished CH-code task does not keep the code.
--
-- Companion to sql/257, which removed 273 Companies House auth codes from
-- `entities`. It left one legitimate transient holding: `admin_task_from_extract`
-- maps a `companies_house_letter` extraction to the `ch_auth_code` field, and the
-- extracted code lands in `admin_tasks.value` so somebody can type it into
-- BrightManager. That holding has a real purpose and a short life.
--
-- The risk is not the live task, it is accumulation. Nothing was clearing the value
-- when the task finished, so every code that ever arrived by letter would sit in
-- `admin_tasks` indefinitely — rebuilding, one task at a time, exactly the store
-- sql/257 just removed.
--
-- So: the moment a ch_auth_code task reaches a terminal state, the code goes. Terminal
-- is a timestamp here rather than a stage — `stage` is 'todo' for all 70 current rows
-- and the pipeline stages sit alongside it, so `done_at`, `confirmed_at` and
-- `dismissed_at` are what actually mark completion.
--
-- `bm_value` is cleared too. On a field-disagreement task that column holds
-- BrightManager's side of the comparison, which for this field is also a real code.
--
-- Reopening a cleared task leaves no code behind, which is correct: whoever picks it up
-- reads the letter again. That is a small cost, paid once, against holding filing
-- credentials for client companies we have no use for.

begin;

create or replace function public.admin_tasks_forget_ch_code()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if new.field = 'ch_auth_code'
     and (new.done_at is not null
          or new.confirmed_at is not null
          or new.dismissed_at is not null)
     and (new.value is not null or new.bm_value is not null)
  then
    new.value    := null;
    new.bm_value := null;
  end if;
  return new;
end $$;

comment on function public.admin_tasks_forget_ch_code() is
  'A Companies House auth code is held on an admin task only while someone still needs '
  'to type it into BrightManager. Once the task is done, confirmed or dismissed the '
  'code is dropped, so codes cannot accumulate here. See sql/259 and sql/257.';

drop trigger if exists trg_admin_tasks_forget_ch_code on public.admin_tasks;
create trigger trg_admin_tasks_forget_ch_code
  before insert or update on public.admin_tasks
  for each row execute function public.admin_tasks_forget_ch_code();

-- Retrospective sweep: any already-terminal task still holding a code.
update public.admin_tasks
   set value = null, bm_value = null
 where field = 'ch_auth_code'
   and (done_at is not null or confirmed_at is not null or dismissed_at is not null)
   and (value is not null or bm_value is not null);

commit;
