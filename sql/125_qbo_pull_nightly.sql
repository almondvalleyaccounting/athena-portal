-- 125: Nightly automatic "Pull from QBO" (Billing Review → Pull from QBO).
--
-- qbo-pull does its own work with the service client and relies on the
-- gateway's JWT verification, so the cron invokes it with the (public) anon
-- key as the bearer. Runs at 04:15 UTC — after the Companies House refresh
-- window. New/unmapped QBO customers surface on the home dashboard
-- ("mappings needed" flag reads qbo_customer_mappings where entity_id is
-- null and role <> 'not_a_client').

create or replace function public.run_qbo_pull_nightly()
returns void
language plpgsql
security definer
set search_path = public, net, extensions
as $$
begin
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/qbo-pull',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5la3N5dm5lbGpneHZwY2h3Z2NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDg2NjEsImV4cCI6MjA5MTM4NDY2MX0.fAF6XY0aAYNU9JbpeugNkyd1dXhoQcC3euJJeyzjmuU',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5la3N5dm5lbGpneHZwY2h3Z2NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDg2NjEsImV4cCI6MjA5MTM4NDY2MX0.fAF6XY0aAYNU9JbpeugNkyd1dXhoQcC3euJJeyzjmuU'
    ),
    body := jsonb_build_object('initiated_by', 'nightly-cron'),
    timeout_milliseconds := 150000
  );
end $$;

do $$ begin perform cron.unschedule('qbo-pull-nightly'); exception when others then null; end $$;
select cron.schedule('qbo-pull-nightly', '15 4 * * *', $$select public.run_qbo_pull_nightly()$$);
