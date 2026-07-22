-- 151: Client communications store — persist matched client emails so they
-- appear on the client-page Communications tab, merged with SMS/WhatsApp.
--
-- Background: the /comms module reads Gmail LIVE and stores nothing; the only
-- inbound email ever recorded is a chase/onboarding/reminder match
-- (chase-reply-scan, sql/107). This adds a general per-client email store fed
-- by a new comms-ingest edge function that scans EVERY connected mailbox
-- (shared + personal) and keeps only messages matched to a client address.
--
-- Storage: one row per matched message PER ENTITY (an address can belong to
-- more than one entity — e.g. an individual and their limited company share a
-- contact email). We store the body of the individual message only, not the
-- whole thread. Cross-mailbox duplicates (same mail in two inboxes) share an
-- rfc_message_id and are de-duped at read time in the UI.

-- ── Store ───────────────────────────────────────────────────────────────
create table if not exists public.client_communications (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references public.entities(id) on delete cascade,
  mailbox           text not null,             -- account_email the message was seen in
  gmail_message_id  text not null,             -- per-account Gmail id
  gmail_thread_id   text,                      -- for the "open in Comms" link
  rfc_message_id    text,                      -- RFC822 Message-ID — cross-mailbox dedupe
  direction         text not null check (direction in ('in', 'out')),
  from_email        text,
  from_name         text,
  to_emails         text[] not null default '{}',
  cc_emails         text[] not null default '{}',
  subject           text,
  snippet           text,
  body_html         text,
  body_text         text,
  matched_email     text,                      -- which client address matched
  occurred_at       timestamptz not null,      -- Gmail internalDate
  created_at        timestamptz not null default now(),
  -- One address may map to several entities; dedupe is per-entity per-mailbox.
  unique (entity_id, mailbox, gmail_message_id)
);

create index if not exists client_communications_entity_time_idx
  on public.client_communications (entity_id, occurred_at desc);
create index if not exists client_communications_rfc_idx
  on public.client_communications (rfc_message_id);

alter table public.client_communications enable row level security;
-- Staff read only; the edge function writes with the service role (bypasses RLS).
drop policy if exists client_communications_staff_read on public.client_communications;
create policy client_communications_staff_read on public.client_communications
  for select using (is_active_staff());

-- ── Ingest bookkeeping ────────────────────────────────────────────────────
-- Drives incremental scans (last_scanned_at) and the chunked 12-month backfill
-- (backfilled_through walks backwards until it reaches the 12-month floor).
create table if not exists public.comms_ingest_state (
  mailbox            text primary key,
  last_scanned_at    timestamptz,
  backfilled_through timestamptz,
  updated_at         timestamptz not null default now()
);
alter table public.comms_ingest_state enable row level security;
drop policy if exists comms_ingest_state_staff_read on public.comms_ingest_state;
create policy comms_ingest_state_staff_read on public.comms_ingest_state
  for select using (is_active_staff());

-- ── Cron plumbing ─────────────────────────────────────────────────────────
-- Same pattern as chase-reply-scan (sql/107): shares the onboarding automation
-- cron_secret and gates on its own flag. Starts DISARMED — arm after backfill.
alter table public.onboarding_chase_config
  add column if not exists comms_ingest_enabled boolean not null default false;

create or replace function public.run_comms_ingest()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cfg onboarding_chase_config%rowtype;
begin
  select * into cfg from onboarding_chase_config where id = true;
  if cfg is null or not cfg.comms_ingest_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/comms-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('mode', 'incremental')
  );
end;
$function$;

-- Offset from chase-reply-scan (*/15 on the hour) to spread Gmail API load.
select cron.schedule('comms-ingest', '5,20,35,50 * * * *', $$select run_comms_ingest()$$);
