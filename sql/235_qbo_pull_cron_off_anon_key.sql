-- 235: stop the nightly QBO pull authenticating with the anon key
--
-- run_qbo_pull_nightly() posted to functions/v1/qbo-pull with the project ANON key
-- hardcoded in the function body, as both Authorization and apikey. sql/125 recorded
-- this as deliberate: "qbo-pull does its own work with the service client and relies
-- on the gateway's JWT verification, so the cron invokes it with the (public) anon
-- key as the bearer."
--
-- That is the whole problem in one sentence. Gateway verify_jwt only requires a JWT
-- signed with the project secret, and the anon key is one — and it ships in the
-- frontend bundle. So anyone could invoke qbo-pull, and qbo-pull could not tell them
-- from the cron. Now that the function checks its caller
-- (supabase/functions/_shared/require-staff.ts), the cron has to identify itself as
-- machine traffic rather than as an anonymous browser.
--
-- Uses the same Vault secret trigger_qbo_monthly_pull already uses. Verified against
-- prod: that secret decodes to {"role":"service_role"} and the require-staff helper
-- admits it. Fails loudly into qbo_sync_log if the secret is missing, rather than
-- silently not running.

create or replace function public.run_qbo_pull_nightly()
returns void
language plpgsql
security definer
set search_path to 'public', 'net', 'extensions', 'vault'
as $function$
declare
  v_service_key text;
begin
  select decrypted_secret into v_service_key
  from vault.decrypted_secrets
  where name = 'planning_service_role_key'
  limit 1;

  if v_service_key is null then
    insert into qbo_sync_log (direction, status, error_message, initiated_by)
    values ('pull', 'error',
            'run_qbo_pull_nightly: vault secret planning_service_role_key not set',
            'nightly-cron');
    return;
  end if;

  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/qbo-pull',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object('initiated_by', 'nightly-cron'),
    timeout_milliseconds := 150000
  );
end $function$;

revoke all on function public.run_qbo_pull_nightly() from public, anon, authenticated;
grant execute on function public.run_qbo_pull_nightly() to service_role;
