-- ══════════════════════════════════════════════════════════════
-- Admin module — schema additions, RLS policies, helper functions
-- Run in Supabase SQL Editor against project neksyvneljgxvpchwgch
-- ══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────
-- 0. Add is_portal_admin column to staff_profiles
--
-- The shell frontend references this flag for admin access
-- but it was never created via migration. Add it now and set
-- Bobby's row to true.
-- ────────────────────────────────────────────────────────────

ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS is_portal_admin BOOLEAN DEFAULT false;

-- Set Bobby as portal admin
UPDATE staff_profiles
  SET is_portal_admin = true
  WHERE email = 'bobby@almondvalleyaccounting.co.uk';


-- ────────────────────────────────────────────────────────────
-- 1. RLS policies for portal admins on staff_profiles
--
-- Existing policies let each user read their own row.
-- These add full CRUD for portal admins so the admin module
-- can list/edit/create all staff profiles.
-- ────────────────────────────────────────────────────────────

-- SELECT: admins can read all staff profiles
DROP POLICY IF EXISTS "Portal admins can read all staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can read all staff_profiles"
  ON staff_profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM staff_profiles sp
      WHERE sp.id = auth.uid() AND sp.is_portal_admin = true
    )
  );

-- UPDATE: admins can update all staff profiles
DROP POLICY IF EXISTS "Portal admins can update all staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can update all staff_profiles"
  ON staff_profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM staff_profiles sp
      WHERE sp.id = auth.uid() AND sp.is_portal_admin = true
    )
  );

-- INSERT: admins can create staff profiles (for new auth users)
DROP POLICY IF EXISTS "Portal admins can insert staff_profiles" ON staff_profiles;

CREATE POLICY "Portal admins can insert staff_profiles"
  ON staff_profiles FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM staff_profiles sp
      WHERE sp.id = auth.uid() AND sp.is_portal_admin = true
    )
  );


-- ────────────────────────────────────────────────────────────
-- 2. Function to list auth users
--
-- The client can't query auth.users directly. This SECURITY
-- DEFINER function lets portal admins see who has auth
-- accounts, so they can create staff profiles for new users
-- (like Ryan) who have accounts but no profile row yet.
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
  -- Only portal admins can call this
  IF NOT EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.is_portal_admin = true
  ) THEN
    RAISE EXCEPTION 'Not authorized - portal admin required';
  END IF;

  RETURN QUERY
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at
  FROM auth.users au
  ORDER BY au.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION list_auth_users() TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 3. Function to update auth user email
--
-- Changing email in staff_profiles alone won't update the
-- auth.users email (used for login). This SECURITY DEFINER
-- function updates both atomically.
-- ────────────────────────────────────────────────────────────

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
  -- Only portal admins can call this
  IF NOT EXISTS (
    SELECT 1 FROM staff_profiles
    WHERE staff_profiles.id = auth.uid() AND staff_profiles.is_portal_admin = true
  ) THEN
    RAISE EXCEPTION 'Not authorized - portal admin required';
  END IF;

  -- Update auth.users email
  UPDATE auth.users SET email = p_new_email WHERE auth.users.id = p_user_id;

  -- Update staff_profiles email
  UPDATE staff_profiles SET email = p_new_email WHERE staff_profiles.id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_user_email(UUID, TEXT) TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 4. Track this migration
-- ────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (filename) VALUES ('010_admin_module.sql')
ON CONFLICT (filename) DO NOTHING;
