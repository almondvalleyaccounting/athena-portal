-- ══════════════════════════════════════════════════════════════
-- 123 — Settings area rework: self-service profile edits +
--       portal-clients admin screen RPCs.
--
-- Why RPCs:
--   • staff_profiles has NO self-update policy (only "Portal admins
--     can update all", 010b). update_own_profile lets any staff
--     member change their own name/colour/working_days — and ONLY
--     those columns, so permission flags can never be self-granted.
--   • entity_memberships only has a staff SELECT policy
--     (schema_client_portal.sql) — staff can't delete membership
--     rows directly, so "Revoke" needs a SECURITY DEFINER RPC to
--     actually end a claimed client's data access.
--   • list_portal_clients joins auth.users for last_sign_in_at,
--     which isn't reachable from the client at all.
-- ══════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────
-- 1. update_own_profile — self-service, whitelisted columns only
--    p_colour NULL (or '') clears the colour back to default.
--    p_name / p_working_days NULL or '' keep the existing value.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_own_profile(
  p_name text,
  p_colour text,
  p_working_days text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  result jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_profiles WHERE id = uid) THEN
    RAISE EXCEPTION 'no staff profile for this account';
  END IF;

  UPDATE staff_profiles
     SET name         = COALESCE(NULLIF(trim(p_name), ''), name),
         colour       = NULLIF(trim(COALESCE(p_colour, '')), ''),
         working_days = COALESCE(NULLIF(trim(p_working_days), ''), working_days)
   WHERE id = uid;

  SELECT jsonb_build_object(
           'id', id, 'name', name, 'colour', colour, 'working_days', working_days)
    INTO result
    FROM staff_profiles WHERE id = uid;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION update_own_profile(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION update_own_profile(text, text, text) TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 2. list_portal_clients — every portal invite + claimed user,
--    with last sign-in from auth.users. can_manage_portal only.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION list_portal_clients()
RETURNS TABLE (
  invite_id        uuid,
  email            text,
  entity_id        uuid,
  entity_name      text,
  invited_at       timestamptz,
  claimed_at       timestamptz,
  claimed_user_id  uuid,
  last_sign_in_at  timestamptz,
  has_membership   boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(
       (SELECT can_manage_portal FROM staff_profiles WHERE id = auth.uid()), false) THEN
    RAISE EXCEPTION 'forbidden: can_manage_portal required';
  END IF;

  RETURN QUERY
  SELECT i.id,
         i.email,
         i.entity_id,
         e.name,
         i.created_at,
         i.claimed_at,
         i.claimed_user_id,
         au.last_sign_in_at,
         EXISTS (
           SELECT 1 FROM entity_memberships m
           WHERE m.user_id = i.claimed_user_id AND m.entity_id = i.entity_id
         )
    FROM client_portal_invites i
    JOIN entities e ON e.id = i.entity_id
    LEFT JOIN auth.users au ON au.id = i.claimed_user_id
   ORDER BY e.name, i.email;
END;
$$;

REVOKE ALL ON FUNCTION list_portal_clients() FROM public, anon;
GRANT EXECUTE ON FUNCTION list_portal_clients() TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 3. revoke_portal_access — delete the invite AND the
--    entity_memberships row for (claimed_user_id, entity_id) so
--    a claimed client's data access really ends (the invite-only
--    delete in the onboarding panel leaves memberships behind).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION revoke_portal_access(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv record;
  n_memberships int := 0;
BEGIN
  IF NOT COALESCE(
       (SELECT can_manage_portal FROM staff_profiles WHERE id = auth.uid()), false) THEN
    RAISE EXCEPTION 'forbidden: can_manage_portal required';
  END IF;

  SELECT * INTO inv FROM client_portal_invites WHERE id = p_invite_id;
  IF inv IS NULL THEN
    RAISE EXCEPTION 'invite not found';
  END IF;

  IF inv.claimed_user_id IS NOT NULL THEN
    DELETE FROM entity_memberships
     WHERE user_id = inv.claimed_user_id AND entity_id = inv.entity_id;
    GET DIAGNOSTICS n_memberships = ROW_COUNT;
  END IF;

  DELETE FROM client_portal_invites WHERE id = p_invite_id;

  RETURN jsonb_build_object(
    'ok', true,
    'email', inv.email,
    'entity_id', inv.entity_id,
    'memberships_deleted', n_memberships
  );
END;
$$;

REVOKE ALL ON FUNCTION revoke_portal_access(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION revoke_portal_access(uuid) TO authenticated;
