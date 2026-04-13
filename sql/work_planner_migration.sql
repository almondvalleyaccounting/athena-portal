-- ============================================================
-- ATHENA WORK PLANNER — DATABASE MIGRATION
-- Run in Supabase SQL Editor
-- Spec: athena_work_planner_database_spec_v2
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0. Permission flag on staff_profiles
-- ────────────────────────────────────────────────────────────
ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS work_planner BOOLEAN DEFAULT false;

-- Enable for Bobby and Tracy
UPDATE staff_profiles SET work_planner = true
WHERE email IN ('bobby@almondvalleyaccounting.co.uk', 'tracy@almondvalleyaccounting.co.uk');

-- ────────────────────────────────────────────────────────────
-- 1. quick_tasks
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quick_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  entity_id     UUID REFERENCES entities(id),
  service       TEXT DEFAULT 'Admin'
                CHECK (service IN (
                  'Admin', 'Accounts Production', 'Corporation Tax', 'Self Assessment',
                  'VAT Returns', 'Bookkeeping', 'Payroll', 'Management Accounts',
                  'Company Secretarial', 'Advisory', 'SA302s', 'Accountant Certificates'
                )),
  assignee_id   UUID REFERENCES staff_profiles(id),
  due_date      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '5 days'),
  planned_date  TIMESTAMPTZ,
  duration      INTEGER NOT NULL DEFAULT 15,
  notes         TEXT DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES staff_profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quick_tasks_assignee ON quick_tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_quick_tasks_entity   ON quick_tasks(entity_id);
CREATE INDEX IF NOT EXISTS idx_quick_tasks_due      ON quick_tasks(due_date);

ALTER TABLE quick_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff with work_planner can read quick_tasks"
  ON quick_tasks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can insert quick_tasks"
  ON quick_tasks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can update quick_tasks"
  ON quick_tasks FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can delete quick_tasks"
  ON quick_tasks FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

-- ────────────────────────────────────────────────────────────
-- 2. scheduled_tasks
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  task_type     TEXT NOT NULL DEFAULT 'client_work'
                CHECK (task_type IN ('client_work', 'admin', 'block_out')),
  entity_id     UUID REFERENCES entities(id),
  service       TEXT
                CHECK (service IS NULL OR service IN (
                  'Admin', 'Accounts Production', 'Corporation Tax', 'Self Assessment',
                  'VAT Returns', 'Bookkeeping', 'Payroll', 'Management Accounts',
                  'Company Secretarial', 'Advisory', 'SA302s', 'Accountant Certificates'
                )),
  assignee_id   UUID REFERENCES staff_profiles(id),
  recurring     BOOLEAN NOT NULL DEFAULT false,
  recurrence    TEXT
                CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly', 'quarterly', 'annually')),
  status        TEXT NOT NULL DEFAULT 'not_started'
                CHECK (status IN ('not_started', 'waiting_info', 'in_progress', 'with_client', 'ready_to_file')),
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('brightmanager', 'payroll_checklist', 'manual')),
  deadline_id   UUID REFERENCES deadlines(id) ON DELETE SET NULL,
  planned_date  TIMESTAMPTZ,
  planned_hour  SMALLINT,
  planned_min   SMALLINT DEFAULT 0
                CHECK (planned_min IS NULL OR planned_min IN (0, 15, 30, 45)),
  duration      INTEGER,
  created_by    UUID REFERENCES staff_profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_assignee ON scheduled_tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_entity   ON scheduled_tasks(entity_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_planned  ON scheduled_tasks(planned_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_source   ON scheduled_tasks(source);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_deadline ON scheduled_tasks(deadline_id);

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff with work_planner can read scheduled_tasks"
  ON scheduled_tasks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can insert scheduled_tasks"
  ON scheduled_tasks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can update scheduled_tasks"
  ON scheduled_tasks FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can delete scheduled_tasks"
  ON scheduled_tasks FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

-- ────────────────────────────────────────────────────────────
-- 3. instance_overrides
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS instance_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id       UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  assignee_id     UUID REFERENCES staff_profiles(id),
  status          TEXT
                  CHECK (status IS NULL OR status IN ('not_started', 'waiting_info', 'in_progress', 'with_client', 'ready_to_file')),
  planned_hour    SMALLINT,
  planned_min     SMALLINT
                  CHECK (planned_min IS NULL OR planned_min IN (0, 15, 30, 45)),
  duration        INTEGER,
  service         TEXT
                  CHECK (service IS NULL OR service IN (
                    'Admin', 'Accounts Production', 'Corporation Tax', 'Self Assessment',
                    'VAT Returns', 'Bookkeeping', 'Payroll', 'Management Accounts',
                    'Company Secretarial', 'Advisory', 'SA302s', 'Accountant Certificates'
                  )),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(master_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_instance_overrides_master ON instance_overrides(master_id);
CREATE INDEX IF NOT EXISTS idx_instance_overrides_date   ON instance_overrides(occurrence_date);

ALTER TABLE instance_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff with work_planner can read instance_overrides"
  ON instance_overrides FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can insert instance_overrides"
  ON instance_overrides FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can update instance_overrides"
  ON instance_overrides FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can delete instance_overrides"
  ON instance_overrides FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

-- ────────────────────────────────────────────────────────────
-- 4. completed_tasks
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS completed_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT NOT NULL
                  CHECK (source_type IN ('quick', 'scheduled_instance')),
  source_id       UUID,
  occurrence_date DATE,
  title           TEXT NOT NULL,
  entity_id       UUID,
  service         TEXT,
  assignee_id     UUID,
  completed_by    UUID,
  completion_mins INTEGER,
  not_required    BOOLEAN NOT NULL DEFAULT false,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_completed_tasks_source       ON completed_tasks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_completed_tasks_assignee     ON completed_tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_completed_tasks_entity       ON completed_tasks(entity_id);
CREATE INDEX IF NOT EXISTS idx_completed_tasks_completed_at ON completed_tasks(completed_at);

ALTER TABLE completed_tasks ENABLE ROW LEVEL SECURITY;

-- INSERT only — no UPDATE or DELETE policies
CREATE POLICY "Staff with work_planner can read completed_tasks"
  ON completed_tasks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

CREATE POLICY "Staff with work_planner can insert completed_tasks"
  ON completed_tasks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.work_planner = true
  ));

-- ── Immutability triggers ──

CREATE OR REPLACE FUNCTION tg_completed_tasks_no_update_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'completed_tasks rows are immutable - UPDATE is not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_completed_tasks_no_update
  BEFORE UPDATE ON completed_tasks
  FOR EACH ROW
  EXECUTE FUNCTION tg_completed_tasks_no_update_fn();

CREATE OR REPLACE FUNCTION tg_completed_tasks_no_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'completed_tasks rows are immutable - DELETE is not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_completed_tasks_no_delete
  BEFORE DELETE ON completed_tasks
  FOR EACH ROW
  EXECUTE FUNCTION tg_completed_tasks_no_delete_fn();

-- ────────────────────────────────────────────────────────────
-- 5. Enable realtime for all 4 tables
-- ────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE quick_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE scheduled_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE instance_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE completed_tasks;
