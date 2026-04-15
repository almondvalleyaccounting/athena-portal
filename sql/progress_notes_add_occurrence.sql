-- Add occurrence_date to task_progress_notes for per-instance notes on recurring tasks
-- Run in Supabase SQL Editor

ALTER TABLE task_progress_notes
  ADD COLUMN IF NOT EXISTS occurrence_date DATE;

-- Update index to include occurrence_date for efficient lookups
DROP INDEX IF EXISTS idx_progress_notes_task;
CREATE INDEX idx_progress_notes_task
  ON task_progress_notes(task_type, task_id, occurrence_date);
