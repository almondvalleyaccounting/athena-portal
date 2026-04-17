-- ══════════════════════════════════════════════════════════════
-- Fix: admin RLS circular reference on staff_profiles
--
-- The policies created in 010 reference staff_profiles inside
-- a subquery on staff_profiles itself. RLS applies to the inner
-- query too, creating a circular dependency that blocks all reads.
--
-- Fix: a SECURITY DEFINER helper that bypasses RLS to check the
-- admin flag, then rebuild the policies using it.
-- ══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────
-- 1. Helper function — bypasses RLS to check admin flag
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION is_portal_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_portal_admin FROM staff_profiles WHERE id = auth.uid()),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION is_portal_admin() TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 2. Rebuild the admin RLS policies using the helper
-- ────────────────────────────────────────────────────────────

-- SELECT
DROP POLICY IF EXISTS "Portal admins can read all staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can read all staff_profiles"
  ON staff_profiles FOR SELECT
  USING ( is_portal_admin() );

-- UPDATE
DROP POLICY IF EXISTS "Portal admins can update all staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can update all staff_profiles"
  ON staff_profiles FOR UPDATE
  USING ( is_portal_admin() );

-- INSERT
DROP POLICY IF EXISTS "Portal admins can insert staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can insert staff_profiles"
  ON staff_profiles FOR INSERT
  WITH CHECK ( is_portal_admin() );


-- ────────────────────────────────────────────────────────────
-- 3. Also fix the two SECURITY DEFINER functions from 010
--    (they referenced is_portal_admin inline — replace with
--    the helper for consistency, though they already bypass
--    RLS via SECURITY DEFINER so aren't broken)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION list_auth_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  created_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Not authorized - portal admin required';
  END IF;

  RETURN QUERY
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at
  FROM auth.users au
  ORDER BY au.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin_update_user_email(
  p_user_id UUID,
  p_new_email TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_portal_admin() THEN
    RAISE EXCEPTION 'Not authorized - portal admin required';
  END IF;

  UPDATE auth.users SET email = p_new_email WHERE auth.users.id = p_user_id;
  UPDATE staff_profiles SET email = p_new_email WHERE staff_profiles.id = p_user_id;
END;
$$;
