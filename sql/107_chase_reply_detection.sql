-- 107: Inbound reply detection — stop chasing people who already answered.
--
-- chase-reply-scan (edge fn, cron every 15 min) polls the connected Gmail
-- inbox (info@ — connect it via the Gmail panel; scope now includes
-- gmail.readonly), matches senders against open CH-code chases and active
-- onboardings, and:
--   * logs the reply on the record's activity timeline
--   * stamps client_replied_at so both chase engines HOLD further reminders
--     until a human processes the reply and advances the state
-- It never sends anything and never advances stages itself.

-- Dedupe + audit of matched inbound mail (matched messages only — unmatched
-- inbox traffic is never stored).
create table if not exists chase_inbound_log (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  from_email text not null,
  subject text,
  received_at timestamptz,
  matched_ch_request_ids uuid[] not null default '{}',
  matched_onboarding_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table chase_inbound_log enable row level security;
drop policy if exists chase_inbound_log_staff_read on chase_inbound_log;
create policy chase_inbound_log_staff_read on chase_inbound_log
  for select using (is_active_staff());

-- Reply hold flags. Cleared when staff advance the CH stage (advanceStage
-- resets comms) or explicitly; the chase engines skip while set-and-newer
-- than the last outbound.
alter table ch_code_requests add column if not exists client_replied_at timestamptz;
alter table onboardings add column if not exists client_replied_at timestamptz;

-- Cron plumbing — same pattern as the other onboarding automations; shares
-- onboarding_chase_config.cron_secret ("the general onboarding automation
-- secret") and gates on its own flag.
alter table onboarding_chase_config
  add column if not exists reply_scan_enabled boolean not null default true;

create or replace function public.run_chase_reply_scan()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cfg onboarding_chase_config%rowtype;
begin
  select * into cfg from onboarding_chase_config where id = true;
  if cfg is null or not cfg.reply_scan_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/chase-reply-scan',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object()
  );
end;
$function$;

select cron.schedule('chase-reply-scan', '*/15 * * * *', $$select run_chase_reply_scan()$$);
