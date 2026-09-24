-- 296 — Client Work and Working Papers data follow the sidebar's Reports flag.
--
-- Client Dashboard, Portfolio, Client Reports, KPIs and Working Papers appear in
-- the sidebar only for staff with can_view_reports, but their tables were
-- readable (and mostly writable) by every active staff member. Bobby,
-- 2026-09-24: "lock to match the sidebar".
--
-- How: one RESTRICTIVE policy per table requiring can_view_reports_data().
-- Restrictive policies AND with the existing permissive ones, so every rule
-- already there (the practice-books restriction, dashboard_realm_visible, own
-- favourites…) still applies — this only narrows. The three definer Working
-- Papers views get the same check in their own gate, since a definer view reads
-- its tables as the owner and never sees these policies.
--
-- Callers that keep working unchanged: service_role (portal-dashboard,
-- dashboard-qbo-pull, reports-run, the wp-* functions) bypasses RLS and passes
-- the check anyway; pg_cron runs as the owner; the Onboarding cross-check views
-- are definer views, so their QuickBooks column is unaffected.
--
-- Known knock-on, accepted: Work › Bookkeeping Health's realm-link review
-- (v_bk_realm_link_review, security_invoker) reads qbo_report_connections, so
-- it is empty for staff without Reports.
--
-- Not covered here, still gated on is_active_staff() only: the definer RPCs
-- kpi_definitions_for_entity, kpi_outstanding, kpi_sectors_with_counts,
-- kpi_set_value, dashboard_reports_for_entity, dashboard_grantable_clients,
-- list_dashboard_access, set_report_client_visible. Follow-up.

create or replace function public.can_view_reports_data()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(auth.role() = 'service_role', false)
      or auth.uid() is null and current_user in ('postgres', 'supabase_admin')
      or exists (
        select 1 from public.staff_profiles
         where id = auth.uid() and is_active and can_view_reports
      );
$$;

revoke all on function public.can_view_reports_data() from public, anon;
grant execute on function public.can_view_reports_data() to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'qbo_dashboard_cache', 'qbo_report_connections',
    'dashboard_adjustment_accounts', 'dashboard_oneoff_items', 'dashboard_projection_map',
    'dashboard_projections', 'dashboard_report',
    'kpi_client_override', 'kpi_definition', 'kpi_dimension', 'kpi_dimension_value',
    'kpi_sector', 'kpi_value',
    'report_runs',
    'wp_brightpay_period', 'wp_nominal_map', 'wp_qbo_account', 'wp_qbo_balance', 'wp_signoff'
  ] loop
    execute format('drop policy if exists %I on public.%I', 'reports flag required', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (can_view_reports_data()) with check (can_view_reports_data())',
      'reports flag required', t);
  end loop;
end $$;

-- v_wp_hmrc_qbo_compare (Working Papers › HMRC vs books) is a definer view over
-- wp_nominal_map / wp_qbo_balance / qbo_report_connections, so the policies
-- above never reach it. Add the flag to its own gate. Rebuilt from the live
-- definition so nothing else in it changes; create or replace keeps its grants.
-- (v_wp_paye_credit_origin and v_wp_paye_tax_year read only the hmrc schema and
-- also serve the HMRC module, which every staff member has — left as they are.)
do $$
declare d text;
begin
  d := pg_get_viewdef('public.v_wp_hmrc_qbo_compare'::regclass);
  if position('can_view_reports_data()' in d) = 0 then
    d := replace(d, 'AND hmrc_can_read());', 'AND hmrc_can_read() AND can_view_reports_data());');
    if position('can_view_reports_data()' in d) = 0 then
      raise exception 'v_wp_hmrc_qbo_compare gate not found — definition changed, update 296';
    end if;
    execute 'create or replace view public.v_wp_hmrc_qbo_compare as ' || d;
  end if;
end $$;
