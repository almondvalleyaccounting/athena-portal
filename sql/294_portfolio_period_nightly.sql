-- 294: Portfolio — pull the default PERIOD for every starred client nightly
--
-- The Portfolio page now reports any Client Dashboard period (plus "YTD to last
-- month", its default). Each period reads a dated set of cache rows written by
-- dashboard-qbo-pull's `portfolio` window. sql/293's job keeps the headline
-- metrics current; this one keeps the DEFAULT period current, so the page opens
-- on figures that are at most a day old without anyone pressing Refresh.
--
-- The dates have to be the ones the browser computes, to the day, or the page
-- reads a key nobody wrote. This mirrors portfolioWindow('ytdLastMonth') in
-- src/modules/client-dashboard/portfolioSignals.js:
--   plEnd    last day of last month
--   plStart  1st of the fiscal-year-start month on or before plEnd
--   cmp      both ends 12 months back (month ends stay month ends)
--   chart    24 months ending plEnd
--   asAt     plEnd; arPrev the month end before
--
-- Year end, in the order resolveFiscalYear() uses: the staff override, then
-- v_client_year_end (BrightManager, or tax year for the unincorporated), then
-- QuickBooks' FiscalYearStartMonth, then September.
--
-- 05:45 UTC: fifteen minutes after sql/293's headline pull, so two calls never
-- refresh the same realm's Intuit token at the same moment.

create or replace function public.portfolio_default_window(p_realm text, p_today date default current_date)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $function$
  with ye as (
    select coalesce(
      c.fiscal_year_end_month,
      v.month,
      (select case
         when s ~ '^\d+$' and s::int between 1 and 12 then ((s::int + 10) % 12) + 1
         when s <> '' then ((extract(month from to_date(s, 'Month'))::int + 10) % 12) + 1
       end
       from (select trim(coalesce(q.data->>'fiscal_year_start_month', '')) s
             from public.qbo_dashboard_cache_latest q
             where q.realm_id = p_realm and q.metric_key = 'company') x),
      9
    )::int as end_month
    from public.qbo_report_connections c
    left join public.v_client_year_end v on v.realm_id = c.realm_id
    where c.realm_id = p_realm
  ), w as (
    select (date_trunc('month', p_today) - interval '1 day')::date as pe,
           (end_month % 12) + 1 as fs
    from ye
  ), w2 as (
    select pe, make_date(
             case when extract(month from pe)::int >= fs then extract(year from pe)::int
                  else extract(year from pe)::int - 1 end, fs, 1) as ps
    from w
  )
  select jsonb_build_object(
    'plStart',    ps,
    'plEnd',      pe,
    'cmpStart',   (ps - interval '12 months')::date,
    'cmpEnd',     (date_trunc('month', pe) - interval '11 months' - interval '1 day')::date,
    'chartStart', (date_trunc('month', pe) - interval '23 months')::date,
    'chartEnd',   pe,
    'asAt',       pe,
    'arPrevDate', (date_trunc('month', pe) - interval '1 day')::date
  )
  from w2;
$function$;

revoke all on function public.portfolio_default_window(text, date) from public, anon, authenticated;
grant execute on function public.portfolio_default_window(text, date) to service_role;

create or replace function public.run_portfolio_period_nightly()
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
    raise warning 'run_portfolio_period_nightly: vault secret planning_service_role_key not set';
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
        'window', jsonb_build_object(
          'kind', 'preset',
          'portfolio', public.portfolio_default_window(v_realm)
        )
      ),
      timeout_milliseconds := 150000
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end $function$;

revoke all on function public.run_portfolio_period_nightly() from public, anon, authenticated;
grant execute on function public.run_portfolio_period_nightly() to service_role;

select cron.schedule('portfolio-period-nightly', '45 5 * * *',
  $$select public.run_portfolio_period_nightly()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
  ('portfolio-period-nightly', 'pg_cron',
   'Portfolio period refresh',
   'Client data ingest',
   'Keeps the Portfolio page''s default period ("YTD to last month") current for every starred client: the period and the same period last year, 24 months of monthly P&L for the chart, the balance sheet and debtor/creditor ageing at the period end. Other periods are pulled on demand from the page''s Refresh all.',
   'Starred clients in staff_client_favourites with an active qbo_report_connections row; each client''s own year end (override, BrightManager, QuickBooks, else September). Practice books are skipped.',
   'Automatic, daily at 05:45 UTC — fifteen minutes after the Portfolio figures refresh. pg_cron posts to the dashboard-qbo-pull edge function (portfolio window) once per starred realm, using the service key held in Supabase Vault.',
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
