-- ============================================================
-- CH personal-code "calls required" — Wednesday 09:00 email to Sophie.
--
-- Policy: offer (email 1) + 2 reminders (emails 2 & 3), then a call. Once a
-- director has had 3 emails with no reply and no call/escalation yet
-- (commsOf(r) === 'three_emails' in the UI — the "call due" column), the next
-- action is a phone call. This surfaces that list to the call assignee every
-- Wednesday morning so calls actually get made.
--
-- Recipient = ch_code_chase_config.call_assignee_id (already Sophie Laidlaw),
-- resolved to an email in the edge function. Internal staff email, so it's
-- enabled by default (no client-facing sends here).
-- Edge function: ch-code-calls.
-- ============================================================

alter table ch_code_chase_config
  add column if not exists calls_email_enabled boolean not null default true;

-- Self-gating cron wrapper — safe to leave scheduled; no-ops when disabled.
create or replace function run_ch_code_calls()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg ch_code_chase_config%rowtype;
begin
  select * into cfg from ch_code_chase_config where id = true;
  if cfg is null or not cfg.calls_email_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-code-calls',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$$;

-- Schedule: Wednesday 09:00 UTC = 10:00 UK (BST), drifts to 09:00 UK in winter
-- — same convention as ch-code-weekly (Mon) and onboarding-weekly.
-- Deploy the ch-code-calls edge function first, then run this line:
--   select cron.schedule('ch-code-calls', '0 9 * * 3', $$select run_ch_code_calls()$$);
