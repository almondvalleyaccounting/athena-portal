-- Resolution action used by the data-import "Needs attention" wizard.
-- Creates a prospect entity bound to an unknown BM client reference so
-- that re-running tasks classification attaches every task with that
-- reference. Idempotent: if a row already exists for the BM ID, returns
-- it unchanged. If a row exists with no bm_client_id but a matching
-- name (case-insensitive), adopt the BM ID onto it.

CREATE OR REPLACE FUNCTION public.create_prospect_for_bm_ref(
  p_bm_client_id text,
  p_name text,
  p_type entity_type DEFAULT 'limited_company'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  ent_id uuid;
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  IF NULLIF(p_bm_client_id, '') IS NULL THEN
    RAISE EXCEPTION 'bm_client_id required';
  END IF;
  IF NULLIF(p_name, '') IS NULL THEN
    RAISE EXCEPTION 'name required';
  END IF;

  -- Already bound? Return it.
  SELECT id INTO ent_id FROM entities WHERE bm_client_id = p_bm_client_id LIMIT 1;
  IF ent_id IS NOT NULL THEN
    RETURN ent_id;
  END IF;

  -- Same name, no bm_client_id yet? Adopt it.
  SELECT id INTO ent_id
  FROM entities
  WHERE bm_client_id IS NULL
    AND lower(name) = lower(p_name)
  LIMIT 1;
  IF ent_id IS NOT NULL THEN
    UPDATE entities SET bm_client_id = p_bm_client_id, updated_at = now() WHERE id = ent_id;
    RETURN ent_id;
  END IF;

  INSERT INTO entities (name, type, bm_client_id, entity_status, source)
  VALUES (p_name, p_type, p_bm_client_id, 'prospect', 'brightmanager')
  RETURNING id INTO ent_id;

  RETURN ent_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_prospect_for_bm_ref(text, text, entity_type) TO authenticated;
