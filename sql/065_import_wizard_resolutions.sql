-- Resolution actions for the data-import "Needs attention" wizard.
-- Three classes of action wired in this migration:
--   1. map_bm_ref_to_entity  → bind an unknown BM ID to an existing entity
--   2. ignore_bm_ref / list / unignore → persist "skip this ref" decisions
--   3. clear_company_number_on_entity → resolve a dup-company collision

CREATE TABLE IF NOT EXISTS public.import_ignored_bm_refs (
  bm_client_id text PRIMARY KEY,
  reason       text,
  ignored_by   uuid REFERENCES auth.users(id),
  ignored_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.import_ignored_bm_refs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_ignored_bm_refs read" ON public.import_ignored_bm_refs;
CREATE POLICY "import_ignored_bm_refs read" ON public.import_ignored_bm_refs
  FOR SELECT TO authenticated
  USING (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  );

-- Writes go via SECURITY DEFINER RPCs below.

CREATE OR REPLACE FUNCTION public.map_bm_ref_to_entity(
  p_bm_client_id text,
  p_entity_id    uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  conflict_id uuid;
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
  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'entity_id required';
  END IF;

  SELECT id INTO conflict_id
  FROM entities
  WHERE bm_client_id = p_bm_client_id
    AND id <> p_entity_id
  LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'bm_client_id % already bound to entity %', p_bm_client_id, conflict_id;
  END IF;

  UPDATE entities
     SET bm_client_id = p_bm_client_id,
         updated_at   = now()
   WHERE id = p_entity_id;

  RETURN p_entity_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ignore_bm_ref(
  p_bm_client_id text,
  p_reason       text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  INSERT INTO import_ignored_bm_refs (bm_client_id, reason, ignored_by)
  VALUES (p_bm_client_id, NULLIF(p_reason, ''), auth.uid())
  ON CONFLICT (bm_client_id) DO UPDATE SET
    reason     = EXCLUDED.reason,
    ignored_by = EXCLUDED.ignored_by,
    ignored_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.unignore_bm_ref(p_bm_client_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;
  DELETE FROM import_ignored_bm_refs WHERE bm_client_id = p_bm_client_id;
END;
$$;

-- Resolve a "duplicate company_number" collision by clearing the value
-- from the existing record. Next BM clients import will then write the
-- company_number onto the BM-owned record cleanly.
CREATE OR REPLACE FUNCTION public.clear_company_number_on_entity(p_entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;
  UPDATE entities
     SET company_number = NULL,
         updated_at     = now()
   WHERE id = p_entity_id;
END;
$$;

-- Search RPC for the wizard's entity picker. Returns top matches by
-- name / bm_client_id / company_number.
CREATE OR REPLACE FUNCTION public.search_entities_for_wizard(p_query text, p_limit int DEFAULT 12)
RETURNS TABLE (
  id uuid,
  name text,
  type entity_type,
  bm_client_id text,
  company_number text,
  entity_status entity_status
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH q AS (SELECT NULLIF(trim(p_query), '') AS s)
  SELECT e.id, e.name, e.type, e.bm_client_id, e.company_number, e.entity_status
  FROM entities e, q
  WHERE q.s IS NULL
     OR e.name ILIKE '%' || q.s || '%'
     OR e.bm_client_id ILIKE q.s || '%'
     OR e.company_number ILIKE q.s || '%'
  ORDER BY
    CASE WHEN e.bm_client_id IS NULL THEN 0 ELSE 1 END,  -- unbound first
    e.name
  LIMIT GREATEST(1, LEAST(p_limit, 50));
$$;

GRANT EXECUTE ON FUNCTION public.map_bm_ref_to_entity(text, uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_bm_ref(text, text)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.unignore_bm_ref(text)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_company_number_on_entity(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_entities_for_wizard(text, int)       TO authenticated;
