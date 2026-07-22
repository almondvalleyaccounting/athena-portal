-- 149: two guarantees for Client Tax Reminders.
--   (1) A client can never end up with duplicate emails in the queue or a
--       duplicate offer/reminder in a batch run — enforced in the DB, not
--       just in app code (races, double-cron fires, manual re-queues).
--   (2) Every opt-in / opt-out change is logged with who + when, even
--       though client_comm_preferences only holds the latest state.
-- Applied to prod 2026-07-22.
--
-- NOTE (prod only, not in this file): before the unique indexes could be
-- created, three duplicate test rows (Bobby's own repeated test sends to
-- himself + one test-reroute) were removed, and comm_preference_events was
-- seeded with the current non-pending preferences as a baseline. Those are
-- one-off data steps, not schema, so they live only in prod.

-- ── Part 1: queue uniqueness backstops ──────────────────────────────────

-- No client can have two emails sitting in the queue at once (per comm type).
create unique index if not exists reminder_emails_one_queued_per_client
  on public.reminder_emails (entity_id, comm_type)
  where status = 'queued';

-- No client gets two payment reminders (reminder or no_utr) in one batch run.
create unique index if not exists reminder_emails_one_reminder_per_batch
  on public.reminder_emails (entity_id, batch_id)
  where kind in ('reminder', 'no_utr') and status in ('queued', 'sent');

-- No client gets two opt-in offer emails — promo is once, ever.
create unique index if not exists reminder_emails_one_promo_ever
  on public.reminder_emails (entity_id, comm_type)
  where kind = 'promo' and status in ('queued', 'sent');

-- ── Part 2: consent-change audit trail ──────────────────────────────────
-- Append-only history of every opt-in/opt-out change, so "who and when" is
-- preserved even though client_comm_preferences only holds the latest state.
create table if not exists public.comm_preference_events (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  comm_type   text not null references public.comm_types(id),
  old_status  text,
  new_status  text not null,
  decided_via text,           -- staff | email_link | email_reply
  changed_by  uuid references public.staff_profiles(id),
  changed_at  timestamptz not null default now()
);
create index if not exists comm_preference_events_entity_idx
  on public.comm_preference_events (entity_id, comm_type, changed_at desc);

alter table public.comm_preference_events enable row level security;
drop policy if exists comm_preference_events_read on public.comm_preference_events;
create policy comm_preference_events_read on public.comm_preference_events
  for select to authenticated using (true);

-- Trigger: log a row whenever status is set (insert) or changes (update).
-- SECURITY DEFINER so it can write the log regardless of the caller's RLS
-- (staff UI writes under the user's JWT; edge fns under the service role).
create or replace function public.log_comm_preference_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;  -- status unchanged; nothing to log
  end if;
  insert into public.comm_preference_events
    (entity_id, comm_type, old_status, new_status, decided_via, changed_by, changed_at)
  values
    (new.entity_id, new.comm_type,
     case when tg_op = 'UPDATE' then old.status else null end,
     new.status, new.decided_via, new.decided_by, coalesce(new.decided_at, now()));
  return new;
end;
$$;

drop trigger if exists trg_log_comm_preference_change on public.client_comm_preferences;
create trigger trg_log_comm_preference_change
  after insert or update on public.client_comm_preferences
  for each row execute function public.log_comm_preference_change();
