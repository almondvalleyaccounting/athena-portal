-- 132: Telnyx SMS integration — config + message log.
--
-- telnyx_config: singleton holding the API key, sending number and webhook
-- secret. NO RLS policies on purpose — only the service role (edge
-- functions) can read it; the key never reaches the browser.
-- sms_messages: every message in/out, matched to a client where possible.
-- Sending: sms-send edge function (staff JWT). Receiving: telnyx-inbound
-- webhook (validated by the webhook_secret in the URL). This is the channel
-- the triage escalation ladder will use.

create table if not exists public.telnyx_config (
  id boolean primary key default true check (id),
  api_key text,
  from_number text,                -- E.164, e.g. +447700900123
  messaging_profile_id text,
  webhook_secret text not null default encode(gen_random_bytes(18), 'hex'),
  -- Clerk SMS's original webhook endpoint. telnyx-inbound re-posts every
  -- event here verbatim so MS Teams keeps receiving texts (Athena is the
  -- profile's primary webhook; Clerk is also the Telnyx failover URL).
  relay_url text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.telnyx_config enable row level security;
insert into public.telnyx_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('out', 'in')),
  entity_id uuid references public.entities(id),
  to_number text not null,
  from_number text not null,
  body text not null,
  telnyx_message_id text unique,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  error text,
  triage_case_id uuid references public.triage_cases(id),
  sent_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists sms_messages_entity_idx on public.sms_messages(entity_id, created_at desc);
create index if not exists sms_messages_created_idx on public.sms_messages(created_at desc);

alter table public.sms_messages enable row level security;
drop policy if exists "Staff view sms messages" on public.sms_messages;
create policy "Staff view sms messages" on public.sms_messages
  for select using (is_active_staff());
-- Writes happen only via edge functions (service role).
