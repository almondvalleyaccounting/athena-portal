-- ============================================================
-- "Update Athena" reminder to Bobby — Friday 15:00 + Sunday 19:00 UK.
-- Posts to the athena-reminder edge function with the shared digest cron secret.
-- UTC crons (BST): Fri 14:00, Sun 18:00 — drift to 15:00/19:00 GMT in winter,
-- same convention as the other Athena crons.
-- ============================================================

create or replace function run_athena_reminder(p_moment text)
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare v_secret text;
begin
  select cron_secret into v_secret from deadline_digest_config where id = true;
  perform net.http_post(
    url     := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/athena-reminder',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body    := jsonb_build_object('dry_run', false, 'moment', p_moment)
  );
end;
$$;

select cron.schedule('athena-reminder-fri', '0 14 * * 5', $$select run_athena_reminder('friday')$$);
select cron.schedule('athena-reminder-sun', '0 18 * * 0', $$select run_athena_reminder('sunday')$$);
