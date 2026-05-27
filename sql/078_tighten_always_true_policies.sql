-- Tighten RLS policies that granted unrestricted access to any
-- authenticated user (USING/WITH CHECK = true). These tables hold
-- staff-internal data (capacity planning, PD reviews, financial plans,
-- fee-earner allocations). The portal shares one Supabase Auth pool
-- with future client logins, so `true` would expose this data to any
-- client the moment one is onboarded. Gate them on is_active_staff().
--
-- No-op for current users: all existing auth users are active staff.
-- Service-role callers (edge functions, cron) bypass RLS regardless.
-- The intentionally-public service_catalogue read policy is left as-is.

-- ── ALL policies (both USING and WITH CHECK were true) ───────────────
ALTER POLICY allocation_changes_all ON allocation_changes
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY capacity_shifts_all ON capacity_shifts
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY entity_people_all ON entity_people
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY people_all ON people
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_cpd_entries_authenticated ON pd_cpd_entries
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_kudos_authenticated ON pd_kudos
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_objectives_authenticated ON pd_objectives
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_one_to_one_actions_authenticated ON pd_one_to_one_actions
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_one_to_ones_authenticated ON pd_one_to_ones
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_skill_levels_authenticated ON pd_skill_levels
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY pd_skills_authenticated ON pd_skills
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write client overrides" ON plan_client_overrides
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write overhead lines" ON plan_overhead_lines
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write owner comp" ON plan_owner_comp_lines
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write pl cache" ON plan_qbo_pl_cache
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write scenarios" ON plan_scenarios
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write staff lines" ON plan_staff_lines
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY "staff write unbilled review" ON plan_unbilled_review
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY service_effort_defaults_all ON service_effort_defaults
  USING (is_active_staff()) WITH CHECK (is_active_staff());
ALTER POLICY service_effort_overrides_all ON service_effort_overrides
  USING (is_active_staff()) WITH CHECK (is_active_staff());

-- ── SELECT read companions (USING was true) ──────────────────────────
ALTER POLICY "staff read client overrides" ON plan_client_overrides
  USING (is_active_staff());
ALTER POLICY "staff read overhead lines" ON plan_overhead_lines
  USING (is_active_staff());
ALTER POLICY "staff read owner comp" ON plan_owner_comp_lines
  USING (is_active_staff());
ALTER POLICY "staff read pl cache" ON plan_qbo_pl_cache
  USING (is_active_staff());
ALTER POLICY "staff read cron runs" ON plan_qbo_sync_runs
  USING (is_active_staff());
ALTER POLICY "staff read scenarios" ON plan_scenarios
  USING (is_active_staff());
ALTER POLICY "staff read staff lines" ON plan_staff_lines
  USING (is_active_staff());
ALTER POLICY "staff read unbilled review" ON plan_unbilled_review
  USING (is_active_staff());
ALTER POLICY qbo_service_items_staff_read ON qbo_service_items
  USING (is_active_staff());
ALTER POLICY "Authenticated can read priority log" ON entity_priority_log
  USING (is_active_staff());
ALTER POLICY "Authenticated can read ready_now_change_requests" ON ready_now_change_requests
  USING (is_active_staff());

-- ── ready_now_change_requests update/delete (USING was true) ─────────
-- INSERT policy keeps its created_by check; only USING is tightened.
ALTER POLICY "Authenticated can update ready_now_change_requests" ON ready_now_change_requests
  USING (is_active_staff());
ALTER POLICY "Authenticated can delete ready_now_change_requests" ON ready_now_change_requests
  USING (is_active_staff());

-- ── UPDATE policies where USING was true but WITH CHECK already gated ─
-- Only USING is changed; the existing permission-specific WITH CHECK
-- (can_edit_quotes / can_manage_portal / can_edit_fee_schedule) stays.
ALTER POLICY client_service_allocations_update ON client_service_allocations
  USING (is_active_staff());
ALTER POLICY entity_fees_update ON entity_fees
  USING (is_active_staff());
ALTER POLICY quote_defaults_update ON quote_defaults
  USING (is_active_staff());
ALTER POLICY quote_entities_update ON quote_entities
  USING (is_active_staff());
