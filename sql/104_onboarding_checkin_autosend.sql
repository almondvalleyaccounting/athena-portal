-- ============================================================
-- 3-month client check-in — default the due date + automate the send.
--
-- Two fixes for the check-in on the onboarding page:
--   1. checkin_due was only ever populated by a one-time backfill, so every
--      onboarding created since had a blank check-in date ("dates don't work").
--      A BEFORE INSERT trigger now defaults it to started_at + 3 months for all
--      code paths (still editable in the panel).
--   2. The check-in email was a manual button. The onboarding-checkin edge
--      function (cron: run_onboarding_checkin, daily) now sends it automatically
--      when it falls due — the point of the panel is to schedule it.
--
-- Safety: DISARMED by default (checkin_auto_send_enabled = false) because this
-- sends client-facing email. The edge function also has a recency guard so
-- arming it never blasts the historical backfill of past-due dates.
-- ============================================================

-- ── 1. Default checkin_due on insert ─────────────────────────
create or replace function set_checkin_due_default()
returns trigger
language plpgsql
as $$
begin
  if new.checkin_due is null then
    new.checkin_due := coalesce(new.started_at, current_date) + interval '3 months';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_checkin_due on onboardings;
create trigger trg_set_checkin_due
  before insert on onboardings
  for each row execute function set_checkin_due_default();

-- Backfill any active onboarding that slipped through with a null due date
-- (created after the original backfill, before this trigger existed).
update onboardings
   set checkin_due = started_at + interval '3 months'
 where checkin_due is null and status in ('active','on_hold','issues');

-- ── 2. Auto-send config + cron wrapper ───────────────────────
alter table onboarding_chase_config
  add column if not exists checkin_auto_send_enabled boolean not null default false;

-- Self-gating cron wrapper — safe to schedule daily; the edge function itself
-- re-checks checkin_auto_send_enabled, so this is belt-and-braces.
create or replace function run_onboarding_checkin()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg onboarding_chase_config%rowtype;
begin
  select * into cfg from onboarding_chase_config where id = true;
  if cfg is null or not cfg.checkin_auto_send_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/onboarding-checkin',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$$;

-- DISARMED. To go live, after deploying the onboarding-checkin edge function:
--   1. Review/clear any stale checkin_due dates you don't want auto-sent.
--   2. update onboarding_chase_config set checkin_auto_send_enabled = true where id = true;
--   3. select cron.schedule('onboarding-checkin', '0 8 * * *', $$select run_onboarding_checkin()$$);
--      (daily 08:00 UTC; the recency guard means only recently-due check-ins go out)
