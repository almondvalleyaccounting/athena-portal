-- ══════════════════════════════════════════════════════════════
-- Fix: ensure all authenticated users can read staff_profiles
--
-- Multiple features (assign-to dropdowns, work planner, client
-- detail, billing) need to read staff names. This policy
-- guarantees that any authenticated user can SELECT from
-- staff_profiles regardless of admin status.
-- ══════════════════════════════════════════════════════════════

-- Drop if exists to make idempotent
DROP POLICY IF EXISTS "Authenticated users can read staff_profiles" ON staff_profiles;

CREATE POLICY "Authenticated users can read staff_profiles"
  ON staff_profiles FOR SELECT
  USING ( auth.role() = 'authenticated' );
