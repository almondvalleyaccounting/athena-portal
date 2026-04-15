-- Allow active staff to delete ideas
-- Run in Supabase SQL Editor

CREATE POLICY "Active staff can delete ideas"
  ON ideas FOR DELETE USING (is_active_staff());
