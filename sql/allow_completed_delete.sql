-- Allow deletion of completed_tasks (removes immutability trigger for DELETE only)
-- UPDATE trigger remains — completed tasks can be deleted but not modified
-- Run in Supabase SQL Editor

DROP TRIGGER IF EXISTS tg_completed_tasks_no_delete ON completed_tasks;

CREATE POLICY "Staff can delete completed tasks"
  ON completed_tasks FOR DELETE USING (
    EXISTS (SELECT 1 FROM staff_profiles WHERE id = auth.uid() AND work_planner = true)
  );
