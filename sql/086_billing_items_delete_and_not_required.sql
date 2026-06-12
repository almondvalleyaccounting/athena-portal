-- Billing module: allow deletes + add a "not required" status.
--
-- 1. billing_items had SELECT/INSERT/UPDATE RLS policies but no DELETE
--    policy, so deletes silently affected 0 rows (RLS blocks with no
--    error) and the rows reappeared on reload. Add a staff DELETE policy,
--    matching the other policies' predicate (is_active_staff()).
-- 2. Extend the status CHECK constraint with 'not_required' so a bill can
--    be parked as not needed (kept out of the pipeline, not pushed).

create policy "Staff can delete billing"
  on billing_items for delete
  using (is_active_staff());

alter table billing_items drop constraint if exists billing_items_status_check;
alter table billing_items add constraint billing_items_status_check
  check (status = any (array['draft','pending_approval','approved','pushed','rejected','not_required']));
