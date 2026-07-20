-- 103: CH reminder auto-queue — a daily job that QUEUES reminders, never sends.
--
-- ch-code-queue-fill applies the reminder ladder (chase_every_days gap, capped
-- at 1 human-sent initial + max_chases reminders per stage) and inserts rows
-- on ch_code_email_queue. Sending still only happens when a human reviews the
-- queue and hits "Send All" (ch-code-queue-send). First email of a stage is
-- never auto-queued — reminders only.
--
-- Gated on ch_code_chase_config.auto_queue_enabled so the cron can be armed /
-- disarmed without touching the schedule.

alter table ch_code_chase_config
  add column if not exists auto_queue_enabled boolean not null default false;

create or replace function public.run_ch_code_queue_fill()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cfg ch_code_chase_config%rowtype;
begin
  select * into cfg from ch_code_chase_config where id = true;
  if cfg is null or not cfg.auto_queue_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/ch-code-queue-fill',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$function$;

-- Weekday mornings, before Sophie's queue review.
select cron.schedule('ch-code-queue-fill', '0 7 * * 1-5', $$select run_ch_code_queue_fill()$$);
