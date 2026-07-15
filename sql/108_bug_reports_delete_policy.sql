-- 108_bug_reports_delete_policy.sql
-- Applied as migration `bug_reports_delete_policy` (15/07/2026).
-- bug_reports had INSERT/SELECT/UPDATE policies for active staff but no DELETE
-- policy, so RLS silently blocked deletes — a "deleted" bug reappeared on
-- refresh. Add the matching DELETE policy.
create policy "Active staff can delete bug reports" on bug_reports
  for delete to public using (is_active_staff());
