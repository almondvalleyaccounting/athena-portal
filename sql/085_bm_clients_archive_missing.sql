-- BM Clients import: archive clients that have dropped out of the export.
--
-- The import_bm_clients RPC only ever *upserts* the rows present in the
-- uploaded CSV (and marks them active). When a client is archived in
-- BrightManager it simply disappears from the next export — but its Athena
-- entity was left untouched at entity_status='active', so archived BM
-- clients lingered as active forever (e.g. Scotia Holdings Ltd).
--
-- This adds the "disappearance" half of the sync, mirroring how bm_tasks
-- already completes tasks that vanish from the tasks CSV:
--
--   preview_bm_archive_candidates(ids) - READ ONLY. Given the set of
--     bm_client_ids present in the upload, return the active BrightManager
--     entities NOT in that set. Surfaced in the import preview so the user
--     can review (and deselect) before anything is written.
--
--   archive_bm_clients(run_id, ids)    - WRITE. Flip the given bm_client_ids
--     to entity_status='archived'. Only touches source='brightmanager'
--     entities that are currently 'active', so it's a no-op on anything the
--     user deselected or that was already archived. Reversible (status flip).
--
-- The caller passes only the user-confirmed subset to archive_bm_clients, so
-- a partial/filtered export can never mass-archive without explicit consent.

-- ─── Preview (read-only) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_bm_archive_candidates(
  p_bm_client_ids text[]
)
RETURNS TABLE (
  id uuid,
  name text,
  type entity_type,
  bm_client_id text,
  manager text,
  updated_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT e.id, e.name, e.type, e.bm_client_id, e.manager, e.updated_at
  FROM entities e
  WHERE e.source = 'brightmanager'
    AND e.entity_status = 'active'
    AND e.bm_client_id IS NOT NULL
    AND NOT (e.bm_client_id = ANY (COALESCE(p_bm_client_ids, ARRAY[]::text[])))
    AND (
      COALESCE(is_portal_admin(), false)
      OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
    )
  ORDER BY e.updated_at DESC, e.name;
$$;

-- ─── Archive (write) ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_bm_clients(
  run_id uuid,
  p_bm_client_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  archived_ids text[];
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM import_log WHERE id = run_id AND status = 'running') THEN
    RAISE EXCEPTION 'import_log % not in running status', run_id;
  END IF;

  IF p_bm_client_ids IS NULL OR array_length(p_bm_client_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('archived', 0, 'archived_ids', '[]'::jsonb);
  END IF;

  WITH updated AS (
    UPDATE entities
       SET entity_status = 'archived',
           updated_at    = now()
     WHERE source = 'brightmanager'
       AND entity_status = 'active'
       AND bm_client_id = ANY (p_bm_client_ids)
    RETURNING bm_client_id
  )
  SELECT array_agg(bm_client_id) INTO archived_ids FROM updated;

  RETURN jsonb_build_object(
    'archived', COALESCE(array_length(archived_ids, 1), 0),
    'archived_ids', COALESCE(to_jsonb(archived_ids), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_bm_archive_candidates(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_bm_clients(uuid, text[]) TO authenticated;
