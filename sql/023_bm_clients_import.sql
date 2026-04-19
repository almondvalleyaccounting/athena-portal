-- ══════════════════════════════════════════════════════════════
-- 023_bm_clients_import.sql
--
-- Server-side pipeline for the BrightManager Clients import.
--
-- Two RPCs:
--   match_bm_prospects(rows jsonb) -> jsonb
--     Takes an array of {bm_client_id, company_number, name} and returns
--     per-row match classification: tier 1 (company number), tier 2
--     (bm_client_id / internal reference already on a prospect), tier 3
--     (fuzzy name similarity >= 0.75), or null (no match).
--
--   import_bm_clients(run_id uuid, payload jsonb) -> jsonb
--     Single-transaction writer. Upserts entities on bm_client_id.
--     Converts prospects to active where the caller approved the
--     conversion (payload rows include `convert_prospect_id`).
--
-- Scope (v1 — BM Clients entities only):
--   Writes entities. No users, no memberships, no services, no deadlines.
--
-- Why no users in v1:
--   `users.id` is FK → auth.users.id ON DELETE CASCADE. Creating a user
--   row requires a matching auth.users row, which requires the existing
--   invite-user edge function (which sends an invite email, creates an
--   auth session, etc.). Auto-creating auth accounts for 500+ imported
--   clients is the wrong side effect. User provisioning remains a
--   deliberate invite-driven flow. A later migration can introduce a
--   `contacts` table for BM-sourced contact data that isn't yet
--   login-ready.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- pg_trgm gives us similarity() for Tier 3 fuzzy matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ────────────────────────────────────────────────────────────
-- match_bm_prospects
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_bm_prospects(rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  r jsonb;
  matched record;
  tier int;
  prospect_id uuid;
  prospect_name text;
  score numeric;
BEGIN
  -- Permission gate
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(rows)
  LOOP
    tier := NULL; prospect_id := NULL; prospect_name := NULL; score := NULL;

    -- Tier 1: exact company_number match on a prospect
    IF NULLIF(r->>'company_number', '') IS NOT NULL THEN
      SELECT id, name INTO prospect_id, prospect_name
      FROM entities
      WHERE entity_status = 'prospect'
        AND company_number = r->>'company_number'
      LIMIT 1;
      IF prospect_id IS NOT NULL THEN tier := 1; END IF;
    END IF;

    -- Tier 2: exact bm_client_id match on a prospect
    IF tier IS NULL AND NULLIF(r->>'bm_client_id', '') IS NOT NULL THEN
      SELECT id, name INTO prospect_id, prospect_name
      FROM entities
      WHERE entity_status = 'prospect'
        AND bm_client_id = r->>'bm_client_id'
      LIMIT 1;
      IF prospect_id IS NOT NULL THEN tier := 2; END IF;
    END IF;

    -- Tier 3: fuzzy name similarity >= 0.75 on a prospect
    IF tier IS NULL AND NULLIF(r->>'name', '') IS NOT NULL THEN
      SELECT id, name, similarity(lower(name), lower(r->>'name')) AS s
        INTO matched
      FROM entities
      WHERE entity_status = 'prospect'
        AND similarity(lower(name), lower(r->>'name')) >= 0.75
      ORDER BY s DESC
      LIMIT 1;
      IF matched.id IS NOT NULL THEN
        tier := 3;
        prospect_id := matched.id;
        prospect_name := matched.name;
        score := matched.s;
      END IF;
    END IF;

    result := result || jsonb_build_object(
      'bm_client_id', r->>'bm_client_id',
      'tier', tier,
      'prospect_id', prospect_id,
      'prospect_name', prospect_name,
      'score', score
    );
  END LOOP;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION match_bm_prospects(jsonb) TO authenticated;


-- ────────────────────────────────────────────────────────────
-- import_bm_clients
-- ────────────────────────────────────────────────────────────
-- Payload shape:
--   { "rows": [ {
--       "bm_client_id": "ABC001",            -- required
--       "name": "Foo Ltd",                   -- required
--       "type": "limited_company",           -- required, matches entity_type
--       "company_number": "SC123456",
--       "utr": "1234567890",
--       "vat_number": "123456789",
--       "paye_ref": "120/AB12345",
--       "accounts_office_ref": "120PC...",
--       "ch_auth_code": "ABC123",
--       "manager": "Bobby Gallacher",
--       "grade": "A",
--       "convert_prospect_id": "uuid|null"
--     }, ... ] }
--
-- Returns:
--   { entities_written:int, prospects_converted:int,
--     errors:[{bm_client_id, message}], skipped:[{bm_client_id, reason}] }

CREATE OR REPLACE FUNCTION import_bm_clients(run_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row_input jsonb;
  ent_id uuid;
  convert_id uuid;
  errs jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  entities_written int := 0;
  prospects_converted int := 0;
BEGIN
  -- Permission gate
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  -- Run must be in 'running' status
  IF NOT EXISTS (SELECT 1 FROM import_log WHERE id = run_id AND status = 'running') THEN
    RAISE EXCEPTION 'import_log % not in running status', run_id;
  END IF;

  FOR row_input IN SELECT * FROM jsonb_array_elements(payload->'rows')
  LOOP
    BEGIN
      -- Guard: bm_client_id required
      IF NULLIF(row_input->>'bm_client_id', '') IS NULL THEN
        skipped := skipped || jsonb_build_object(
          'bm_client_id', null,
          'reason', 'missing bm_client_id (Internal Reference)'
        );
        CONTINUE;
      END IF;
      IF NULLIF(row_input->>'name', '') IS NULL THEN
        skipped := skipped || jsonb_build_object(
          'bm_client_id', row_input->>'bm_client_id',
          'reason', 'missing name'
        );
        CONTINUE;
      END IF;
      IF NULLIF(row_input->>'type', '') IS NULL THEN
        skipped := skipped || jsonb_build_object(
          'bm_client_id', row_input->>'bm_client_id',
          'reason', 'missing/unmapped type'
        );
        CONTINUE;
      END IF;

      ent_id := NULL;
      convert_id := NULLIF(row_input->>'convert_prospect_id', '')::uuid;

      -- Prospect conversion path — update in place
      IF convert_id IS NOT NULL THEN
        UPDATE entities SET
          name                = row_input->>'name',
          type                = (row_input->>'type')::entity_type,
          bm_client_id        = row_input->>'bm_client_id',
          company_number      = NULLIF(row_input->>'company_number', ''),
          utr                 = NULLIF(row_input->>'utr', ''),
          vat_number          = NULLIF(row_input->>'vat_number', ''),
          paye_ref            = NULLIF(row_input->>'paye_ref', ''),
          accounts_office_ref = NULLIF(row_input->>'accounts_office_ref', ''),
          ch_auth_code        = NULLIF(row_input->>'ch_auth_code', ''),
          manager             = NULLIF(row_input->>'manager', ''),
          grade               = NULLIF(row_input->>'grade', ''),
          entity_status       = 'active',
          source              = 'brightmanager',
          updated_at          = now()
        WHERE id = convert_id
        RETURNING id INTO ent_id;

        IF ent_id IS NOT NULL THEN
          prospects_converted := prospects_converted + 1;
          entities_written := entities_written + 1;
          CONTINUE;
        END IF;
      END IF;

      -- Upsert on bm_client_id (partial unique index covers WHERE NOT NULL)
      INSERT INTO entities (
        name, type, bm_client_id, company_number, utr, vat_number,
        paye_ref, accounts_office_ref, ch_auth_code, manager, grade,
        entity_status, source
      ) VALUES (
        row_input->>'name',
        (row_input->>'type')::entity_type,
        row_input->>'bm_client_id',
        NULLIF(row_input->>'company_number', ''),
        NULLIF(row_input->>'utr', ''),
        NULLIF(row_input->>'vat_number', ''),
        NULLIF(row_input->>'paye_ref', ''),
        NULLIF(row_input->>'accounts_office_ref', ''),
        NULLIF(row_input->>'ch_auth_code', ''),
        NULLIF(row_input->>'manager', ''),
        NULLIF(row_input->>'grade', ''),
        'active',
        'brightmanager'
      )
      ON CONFLICT (bm_client_id) WHERE bm_client_id IS NOT NULL DO UPDATE SET
        name                = EXCLUDED.name,
        type                = EXCLUDED.type,
        company_number      = EXCLUDED.company_number,
        utr                 = EXCLUDED.utr,
        vat_number          = EXCLUDED.vat_number,
        paye_ref            = EXCLUDED.paye_ref,
        accounts_office_ref = EXCLUDED.accounts_office_ref,
        ch_auth_code        = EXCLUDED.ch_auth_code,
        manager             = EXCLUDED.manager,
        grade               = EXCLUDED.grade,
        entity_status       = 'active',
        source              = 'brightmanager',
        updated_at          = now()
      RETURNING id INTO ent_id;

      entities_written := entities_written + 1;

    EXCEPTION WHEN OTHERS THEN
      errs := errs || jsonb_build_object(
        'bm_client_id', row_input->>'bm_client_id',
        'message', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'entities_written', entities_written,
    'prospects_converted', prospects_converted,
    'errors', errs,
    'skipped', skipped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION import_bm_clients(uuid, jsonb) TO authenticated;

COMMIT;
