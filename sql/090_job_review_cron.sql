-- Schedules the monthly job-review loop with pg_cron + pg_net.
--
-- Two jobs run daily and self-gate on job_review_config so the cadence is
-- config-driven (no need to reschedule cron when the day changes):
--   run_job_review_monthly() — on cadence_day_of_month: open the cycle + send
--                              one nudge per assignee.
--   run_job_review_chase()   — chase_after_days after the cycle opened: email
--                              anyone with unanswered items (reminder tone).
--
-- Both post to the job-review-notify edge function with the x-cron-secret
-- header taken from job_review_config.cron_secret.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function run_job_review_monthly() returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_cfg    job_review_config%rowtype;
  v_url    text := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/job-review-notify';
begin
  select * into v_cfg from job_review_config where id;
  if extract(day from current_date)::int <> v_cfg.cadence_day_of_month then
    return; -- not the cadence day
  end if;

  perform open_job_review_cycle();  -- service-role context (auth.uid() null) → allowed

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false)
  );
end;
$$;

create or replace function run_job_review_chase() returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_cfg    job_review_config%rowtype;
  v_cycle  job_review_cycle%rowtype;
  v_url    text := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/job-review-notify';
begin
  select * into v_cfg from job_review_config where id;
  select * into v_cycle from job_review_cycle where status = 'open' order by period_month desc limit 1;
  if not found then return; end if;

  -- Fire exactly chase_after_days after the cycle opened.
  if current_date <> ((v_cycle.opened_at at time zone 'UTC')::date + v_cfg.chase_after_days) then
    return;
  end if;
  -- Nothing to chase?
  if not exists (select 1 from job_review_item where cycle_id = v_cycle.id and responded_at is null) then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_cfg.cron_secret),
    body    := jsonb_build_object('dry_run', false, 'only_unanswered', true, 'reminder', true)
  );
end;
$$;

-- Daily triggers (07:00 / 07:30 UTC). The functions self-gate on the config,
-- so most days they no-op. cron.schedule upserts by job name.
--
-- ARM ONLY AFTER end-to-end testing AND job_review_config.sending_enabled = true.
-- Currently DISARMED (unscheduled) so nothing emails the team during testing.
-- To arm, run these two statements:
-- select cron.schedule('job-review-open',  '0 7 * * *',  $$select run_job_review_monthly()$$);
-- select cron.schedule('job-review-chase', '30 7 * * *', $$select run_job_review_chase()$$);
