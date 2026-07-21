-- Human review queue for Client Reminders. reminder_emails gains a
-- lifecycle: rows are QUEUED (rendered + stored, not sent), reviewed by a
-- manager, then RELEASED (actually sent via Gmail) or DROPPED. The
-- rendered body is stored on the row so what a reviewer sees is exactly
-- what goes out. Existing rows were all sent, so they backfill to 'sent'.

alter table public.reminder_emails
  add column if not exists status     text not null default 'sent',
  add column if not exists body_html  text,
  add column if not exists body_text  text,
  add column if not exists queued_at  timestamptz,
  add column if not exists queued_by  uuid references public.staff_profiles(id);

update public.reminder_emails set status = 'sent' where status is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reminder_emails_status_chk'
  ) then
    alter table public.reminder_emails
      add constraint reminder_emails_status_chk check (status in ('queued', 'sent', 'dropped'));
  end if;
end $$;

-- Fast lookup of the pending queue.
create index if not exists reminder_emails_queued_idx
  on public.reminder_emails (batch_id, kind)
  where status = 'queued';
