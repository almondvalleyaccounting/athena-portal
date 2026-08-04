-- 172: a manual override for "already queued or emailed for this run".
--
-- The once-per-batch indexes from sql/149 + sql/150 exist to stop the
-- AUTOMATED filler (and double-cron fires / races) sending a client the same
-- reminder or offer twice. But a human sometimes needs to send it again on
-- purpose — the client says they never got it, the email bounced and a new
-- address is on file, or they've asked for the figures again.
--
-- So: a reminder_emails row can now be flagged is_resend. A resend is a
-- deliberate, attributed extra copy and is exempt from the per-batch caps.
-- Everything else still applies — the one-at-a-time queue index below, the
-- former-client hard stop, and the tax_reminder_ignore exclusions.
--
-- Only reminders-send sets the flag: mode:'queue' with allow_resend:true (a
-- portal manager ticking "Send again"), and the "send test to me" preview,
-- which is likewise an extra copy that shouldn't burn the client's one slot.
-- reminders-autoqueue never sets it, and its own dedup counts resend rows, so
-- a resend does not re-open the auto-queue for that client.

alter table public.reminder_emails
  add column if not exists is_resend boolean not null default false;

comment on column public.reminder_emails.is_resend is
  'True when this row is a deliberate EXTRA copy rather than the client''s one email for the run: a manual resend (queue with allow_resend) or a "send test to me" preview. Exempt from the once-per-batch unique indexes, and does not consume the client''s slot.';

-- Per-batch caps now apply to first sends only; resends are exempt.
drop index if exists public.reminder_emails_one_reminder_per_batch;
create unique index reminder_emails_one_reminder_per_batch
  on public.reminder_emails (entity_id, batch_id)
  where kind in ('reminder', 'no_utr') and status in ('queued', 'sent') and is_resend = false;

drop index if exists public.reminder_emails_one_promo_per_batch;
create unique index reminder_emails_one_promo_per_batch
  on public.reminder_emails (entity_id, batch_id)
  where kind = 'promo' and status in ('queued', 'sent') and is_resend = false;

-- Deliberately UNCHANGED: a client still cannot have two emails sitting in
-- the queue at once. A resend while one is already waiting is a mistake, not
-- an override — release or drop the queued one first. reminders-send now says
-- exactly that instead of the generic "already queued or emailed" message.
--
--   reminder_emails_one_queued_per_client (entity_id, comm_type)
--     where status = 'queued'
