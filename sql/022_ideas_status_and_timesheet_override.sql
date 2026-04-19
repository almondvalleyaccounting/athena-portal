-- ══════════════════════════════════════════════════════════════
-- 022_ideas_status_and_timesheet_override.sql
--
-- Applied via Supabase MCP on 2026-04-19.
--
-- D1: Ideas get a lifecycle `status` field.
--     Values: new | planned | in_progress | done | wont_do. Default 'new'.
-- D2: `timesheet_entries.source` extended with a documented 'override'
--     value, meaning the row replaces completion-sourced minutes for
--     the same (staff, entity, service, date) tuple. No schema change
--     needed — the column is already text. Added a partial index for
--     override-lookup performance + a descriptive column comment.
-- ══════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE ideas
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','planned','in_progress','done','wont_do'));

COMMENT ON COLUMN ideas.status IS
  'Lifecycle: new (just submitted) -> planned (accepted, queued) -> in_progress (being built) -> done, OR wont_do (rejected).';

CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas (status);

COMMENT ON COLUMN timesheet_entries.source IS
  'One of: manual (user-added row), override (replaces a completion-sourced minutes total for the same staff/entity/service/date), completion (auto-synced from a completed task).';

CREATE INDEX IF NOT EXISTS idx_timesheet_entries_override_lookup
  ON timesheet_entries (staff_id, entity_id, service, work_date)
  WHERE source = 'override';

COMMIT;
