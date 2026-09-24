-- 293: nightly refresh of the Portfolio page's QuickBooks figures
--
-- Why: /portfolio reads qbo_dashboard_cache only (it must stay instant), and that
-- cache is filled only when someone opens a client's dashboard. So a starred
-- client's tile could be two months old beside one pulled this morning, and the
-- year-on-year / month-on-month comparisons on the tile were comparing stale
-- against fresh.
--
-- What: one pg_cron job at 05:30 UTC — after qbo-pull-nightly (04:15), so two
-- functions never refresh the same realm's Intuit token at once — that posts to
-- dashboard-qbo-pull once per distinct starred realm, with refresh=true and the
-- headline metrics the Portfolio tile reads. Same Vault secret and service-role
-- identity as run_qbo_pull_nightly (sql/235); dashboard-qbo-pull already admits
-- service callers through require-staff.ts.
--
-- Practice books (is_practice) are skipped: dashboard-qbo-pull refuses them to a
-- service caller by design (they need can_view_practice_financials), so posting
-- would only log a 403. Those tiles refresh from the page's "Refresh all" button.
--
-- Read-only against QuickBooks: it pulls reports into the cache and writes nothing
-- back to any client's books.

create or replace function public.run_portfolio_refresh_nightly()
returns integer
language plpgsql
security definer
set search_path to 'public', 'net', 'extensions', 'vault'
as $function$
declare
  v_service_key text;
  v_realm text;
  v_n integer := 0;
begin
  -- Machine traffic only: pg_cron / psql (no JWT) or service_role.
  if not public.is_staff_or_service() or coalesce(auth.role(), '') = 'authenticated' then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  select decrypted_secret into v_service_key
  from vault.decrypted_secrets
  where name = 'planning_service_role_key'
  limit 1;

  if v_service_key is null then
    raise warning 'run_portfolio_refresh_nightly: vault secret planning_service_role_key not set';
    return 0;
  end if;

  for v_realm in
    select distinct f.realm_id
    from public.staff_client_favourites f
    join public.qbo_report_connections c on c.realm_id = f.realm_id
    where f.realm_id is not null
      and c.status = 'active'
      and not coalesce(c.is_practice, false)
  loop
    perform net.http_post(
      url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/dashboard-qbo-pull',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key
      ),
      body := jsonb_build_object(
        'realmId', v_realm,
        'refresh', true,
        'metrics', jsonb_build_array(
          'pl_fytd', 'pl_fytd_prior', 'balances', 'balance_sheet',
          'pnl_monthly', 'aged_receivables', 'aged_payables', 'file_health'
        )
      ),
      timeout_milliseconds := 150000
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end $function$;

revoke all on function public.run_portfolio_refresh_nightly() from public, anon, authenticated;
grant execute on function public.run_portfolio_refresh_nightly() to service_role;

select cron.schedule('portfolio-refresh-nightly', '30 5 * * *',
  $$select public.run_portfolio_refresh_nightly()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
  ('portfolio-refresh-nightly', 'pg_cron',
   'Portfolio figures refresh',
   'Client data ingest',
   'Keeps the Portfolio page current: re-pulls the headline QuickBooks figures (P&L year to date and the same period last year, balance sheet with last-month and year-ago comparatives, aged debtors and creditors, file health) for every client anyone has starred, so the tiles and their comparisons are never more than a day old.',
   'Starred clients in staff_client_favourites with an active qbo_report_connections row. Practice books are skipped (they refresh from the page''s Refresh all button).',
   'Automatic, daily at 05:30 UTC — after the client QuickBooks nightly pull. pg_cron posts to the dashboard-qbo-pull edge function once per starred realm, using the service key held in Supabase Vault.',
   'The practice Intuit account — each client granted access once at connection time; no per-run sign-in. Read-only: nothing is written back to QuickBooks.',
   null, 13)
on conflict (job_key) do update
  set title       = excluded.title,
      category    = excluded.category,
      purpose     = excluded.purpose,
      data_source = excluded.data_source,
      mechanism   = excluded.mechanism,
      run_as      = excluded.run_as,
      sort_order  = excluded.sort_order,
      updated_at  = now();

-- ── Latest snapshot per (realm, metric) ────────────────────────────────────
-- The Portfolio page used to read every snapshot and pick the newest in the
-- browser. Snapshots are kept (one per period_end), and the nightly job above
-- adds one per metric per day, so that read would soon hit PostgREST's silent
-- ~1000-row cap and quietly drop clients. This view hands back one row each.
--
-- security_invoker: the base table's policies (active staff; practice realms
-- only with can_view_practice_financials) apply to whoever reads the view.
-- A client-portal user reads nothing, exactly as from the table.

create or replace view public.qbo_dashboard_cache_latest
with (security_invoker = true) as
select distinct on (realm_id, metric_key)
  realm_id, metric_key, period_start, period_end, data, pulled_at
from public.qbo_dashboard_cache
order by realm_id, metric_key, pulled_at desc;

revoke all on public.qbo_dashboard_cache_latest from public, anon;
grant select on public.qbo_dashboard_cache_latest to authenticated, service_role;
