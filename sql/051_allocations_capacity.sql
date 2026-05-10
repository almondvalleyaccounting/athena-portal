-- 051_allocations_capacity.sql
-- Adds the schema needed for the Allocations matrix and Capacity heatmap
-- in the Work Planner module.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Staff weekly capacity (used as denominator in capacity heatmap).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS weekly_capacity_hours numeric;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Per-allocation effort override (optional; falls back to defaults).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE client_service_allocations
  ADD COLUMN IF NOT EXISTS effort_hours_override numeric;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Service effort defaults (per canonical service + cadence).
--    Cadence: monthly | quarterly | annual
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_effort_defaults (
  canonical_service_id text NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('monthly','quarterly','annual')),
  hours numeric NOT NULL,
  PRIMARY KEY (canonical_service_id, cadence)
);

INSERT INTO service_effort_defaults (canonical_service_id, cadence, hours) VALUES
  ('bookkeeping',          'monthly',   2.0),
  ('vat_review',           'quarterly', 1.5),
  ('accounts_preparation', 'annual',    8.0),
  ('accounts_submission',  'annual',    1.0)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Allocation change drafts (draft → commit pattern).
--    One pending draft per (entity, service) at a time.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allocation_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  canonical_service_id text NOT NULL,
  proposed_fee_earner_id uuid REFERENCES staff_profiles(id),
  proposed_manager_id uuid REFERENCES staff_profiles(id),
  proposed_effort_hours numeric,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','committed','discarded')),
  note text,
  created_by uuid REFERENCES staff_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  committed_by uuid REFERENCES staff_profiles(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS allocation_changes_one_draft_per_cell
  ON allocation_changes (entity_id, canonical_service_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS allocation_changes_status_idx
  ON allocation_changes (status);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Capacity shifts (pull-forward chunks of work between months).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capacity_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES client_service_allocations(id) ON DELETE CASCADE,
  source_month date NOT NULL, -- first day of month
  target_month date NOT NULL, -- first day of month
  hours numeric NOT NULL CHECK (hours > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','committed','discarded')),
  created_by uuid REFERENCES staff_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE INDEX IF NOT EXISTS capacity_shifts_allocation_idx
  ON capacity_shifts (allocation_id);

CREATE INDEX IF NOT EXISTS capacity_shifts_target_month_idx
  ON capacity_shifts (target_month);

-- ─────────────────────────────────────────────────────────────────────
-- 6. Monthly load view: aggregates bm_task_schedule.scheduled_hours by
--    assignee × month (truncated to first of month). The Capacity view
--    uses this as its baseline; UI layers committed shifts on top.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_capacity_load_monthly AS
SELECT
  bts.assignee_id,
  date_trunc('month', bts.scheduled_for_date)::date AS month,
  SUM(COALESCE(bts.scheduled_hours, 0))::numeric    AS hours,
  COUNT(*)                                          AS task_count
FROM bm_task_schedule bts
WHERE bts.scheduled_for_date IS NOT NULL
  AND bts.assignee_id IS NOT NULL
  AND COALESCE(bts.state, 'committed') <> 'discarded'
GROUP BY bts.assignee_id, date_trunc('month', bts.scheduled_for_date);

-- ─────────────────────────────────────────────────────────────────────
-- 7. RLS: open up new tables to authenticated users (matches the
--    pattern used elsewhere in the work planner).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE service_effort_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_changes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacity_shifts         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_effort_defaults_all" ON service_effort_defaults;
CREATE POLICY "service_effort_defaults_all" ON service_effort_defaults
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allocation_changes_all" ON allocation_changes;
CREATE POLICY "allocation_changes_all" ON allocation_changes
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "capacity_shifts_all" ON capacity_shifts;
CREATE POLICY "capacity_shifts_all" ON capacity_shifts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
