-- 147: allow the 'no_utr' kind on reminder_emails. sql/143 added 'no_utr'
-- to comm_templates but missed reminder_emails' own kind check, so any
-- attempt to queue/send a no_utr email failed the check constraint — and
-- because the auto-queue inserts a whole batch at once, one no_utr row
-- failed the entire insert and left the queue empty. Applied to prod
-- 2026-07-22.

alter table public.reminder_emails drop constraint if exists reminder_emails_kind_check;
alter table public.reminder_emails
  add constraint reminder_emails_kind_check check (kind in ('promo', 'reminder', 'no_utr'));
