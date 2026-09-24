-- 294 — Practice Planning data is for the people who can see Practice Planning.
--
-- The plan_* tables hold salaries (plan_staff_lines), owner pay
-- (plan_owner_comp_lines), overheads, the practice P&L and balance sheet, and
-- the forecast scenarios. The sidebar shows Planning to three people, but every
-- plan_* policy was is_active_staff() — all eleven staff could read it, and
-- write it. plan_bs_cache (the practice balance sheet) was readable by any
-- authenticated login, client-portal users included.
--
-- Now every plan_* table is read and write for can_view_practice_financials()
-- only — the same flag planning-qbo-pull already demands, held today by
-- exactly the three people who have Practice Planning in the sidebar.
-- service_role (planning-qbo-pull) and the owner-run definer functions
-- (trigger_qbo_monthly_pull, reconcile_qbo_sync_responses) bypass RLS and are
-- unaffected. v_plan_baseline_health is security_invoker, so it follows.
--
-- Approved by Bobby, 2026-09-24.

do $$
declare
  t text;
  pol record;
begin
  foreach t in array array[
    'plan_scenarios', 'plan_staff_lines', 'plan_owner_comp_lines', 'plan_overhead_lines',
    'plan_client_overrides', 'plan_qbo_pl_cache', 'plan_bs_cache', 'plan_unbilled_review',
    'plan_qbo_sync_runs'
  ] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (can_view_practice_financials()) with check (can_view_practice_financials())',
      'practice financials only', t);
  end loop;
end $$;

-- The read-only caches and the sync log take no browser writes.
revoke insert, update, delete on public.plan_bs_cache, public.plan_qbo_sync_runs from authenticated;
