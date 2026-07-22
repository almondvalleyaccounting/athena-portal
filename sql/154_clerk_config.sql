-- 154: Clerk Chat config — WhatsApp bridge for the Communications module.
--
-- Clerk Chat holds the practice number's WhatsApp Business registration (it
-- bridges WhatsApp + SMS into MS Teams), so Telnyx cannot send WhatsApp for
-- that number ("The value must be one of ['SMS','MMS']"). Athena therefore
-- talks WhatsApp via Clerk instead:
--   outbound  sms-send → POST https://web-api.clerk.chat/public/messages
--   inbound   Clerk webhook → clerk-inbound edge function → sms_messages
--
-- Mirrors the telnyx_config pattern: single row, service-role only (RLS
-- enabled, no policies — the browser never sees the key).
--
-- Setup after this migration:
--   1. In the Clerk dashboard: Settings → API → create a Teams API key, then
--      paste it here:  update clerk_config set api_key = '<KEY>' where id;
--   2. Read the webhook secret:  select webhook_secret from clerk_config;
--   3. In Clerk: Settings → Webhooks → Add webhook,
--      URL  = https://neksyvneljgxvpchwgch.supabase.co/functions/v1/clerk-inbound
--      events = message.received, message.delivered, message.failed
--      auth header value = the webhook_secret from step 2.

create table if not exists public.clerk_config (
  id boolean primary key default true check (id),
  api_key text,
  webhook_secret text not null default md5(random()::text || clock_timestamp()::text),
  -- Clerk "sender" identifier for WhatsApp sends; the practice number unless
  -- Clerk needs a channel-specific identifier (tune without redeploying).
  whatsapp_sender text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.clerk_config enable row level security;
-- No policies on purpose: service role only.

insert into public.clerk_config (id, whatsapp_sender)
values (true, '+447457412121')
on conflict (id) do nothing;
