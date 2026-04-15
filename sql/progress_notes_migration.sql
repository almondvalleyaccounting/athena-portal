-- ══════════════════════════════════════════════════════════════
-- Task Progress Notes — migration
-- Run in Supabase SQL Editor against project neksyvneljgxvpchwgch
-- ══════════════════════════════════════════════════════════════

-- Table: task_progress_notes
-- Many-to-one on quick_tasks and scheduled_tasks.
-- Append-only (no UPDATE/DELETE policies).
-- is_completion marks the final note added at task completion time.

CREATE TABLE IF NOT EXISTS task_progress_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type       TEXT NOT NULL CHECK (task_type IN ('quick', 'scheduled')),
  task_id         UUID NOT NULL,
  note            TEXT NOT NULL,
  created_by      UUID REFERENCES staff_profiles(id),
  created_by_name TEXT,
  is_completion   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient lookup by task
CREATE INDEX IF NOT EXISTS idx_progress_notes_task
  ON task_progress_notes(task_type, task_id);

-- RLS
ALTER TABLE task_progress_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read notes"
  ON task_progress_notes FOR SELECT USING (
    EXISTS (SELECT 1 FROM staff_profiles WHERE id = auth.uid() AND work_planner = true)
  );

CREATE POLICY "Staff can insert notes"
  ON task_progress_notes FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM staff_profiles WHERE id = auth.uid() AND work_planner = true)
  );

-- Real-time support
ALTER PUBLICATION supabase_realtime ADD TABLE task_progress_notes;
