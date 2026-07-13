-- ============================================================
-- CH personal-code — capture the call date/time.
-- Email stages get their timestamp automatically (ch_code_email_queue.sent_at
-- / the email_out activity). A phone call has none, so when Sophie moves a
-- tile to the "Called" stage the UI prompts for the date & time and stores it
-- here.
-- ============================================================

alter table ch_code_requests add column if not exists called_at timestamptz;
comment on column ch_code_requests.called_at is 'When Sophie logged a phone call to this person, captured via the "Called" stage prompt. Cleared when the tile moves back to a pre-call stage; left intact when escalated.';
