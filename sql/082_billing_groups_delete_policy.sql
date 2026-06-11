-- 082_billing_groups_delete_policy.sql
-- billing_groups had RLS policies for SELECT/INSERT/UPDATE but NO DELETE
-- policy. With RLS enabled, a client-side delete therefore matched no policy
-- and removed 0 rows *without* raising an error — so "Delete Group" appeared
-- to succeed (the detail page navigated away) yet the group stayed in the
-- list. Add a DELETE policy for active staff, mirroring the others.
--
-- billing_group_members already has a "Staff can delete members" policy, and
-- its FK to billing_groups is ON DELETE CASCADE, so deleting the group will
-- also clear its members once this policy is in place.

CREATE POLICY "Staff can delete groups" ON public.billing_groups
  FOR DELETE USING (is_active_staff());
