-- Sanity check on the incoming BM Clients payload:
--   • Each bm_client_id must map to exactly one row. If two rows in the
--     same upload share an Internal Reference, both rows are skipped with
--     a clear reason (we can't tell which is correct, and the previous
--     behaviour silently merged them via ON CONFLICT).
--   • Each name is expected to map to exactly one bm_client_id. Name
--     collisions are surfaced as soft warnings (no skip) since real-world
--     namesakes are possible.

CREATE OR REPLACE FUNCTION public.import_bm_clients(run_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  row_input jsonb;
  ent_id uuid;
  convert_id uuid;
  cn text;
  conflict_id uuid;
  conflict_bm text;
  errs jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  warnings jsonb := '[]'::jsonb;
  entities_written int := 0;
  prospects_converted int := 0;
  orphans_adopted int := 0;
  duplicate_refs jsonb;
  duplicate_names jsonb;
  dup_ref_set text[];
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

  -- Pre-pass: detect duplicate bm_client_id within the payload. Build a
  -- jsonb map: { bm_client_id -> [names...] } for those that appear >1.
  WITH rows_in AS (
    SELECT r->>'bm_client_id' AS bm_id, r->>'name' AS nm
    FROM jsonb_array_elements(payload->'rows') r
    WHERE NULLIF(r->>'bm_client_id', '') IS NOT NULL
  ), grouped AS (
    SELECT bm_id, array_agg(DISTINCT nm) AS names, COUNT(*) AS n
    FROM rows_in GROUP BY bm_id
  )
  SELECT jsonb_object_agg(bm_id, to_jsonb(names))
    INTO duplicate_refs
  FROM grouped WHERE n > 1;

  -- Pre-pass: detect same-name → different bm_client_id (warning only).
  WITH rows_in AS (
    SELECT lower(r->>'name') AS nm_lc, r->>'name' AS nm, r->>'bm_client_id' AS bm_id
    FROM jsonb_array_elements(payload->'rows') r
    WHERE NULLIF(r->>'name', '') IS NOT NULL AND NULLIF(r->>'bm_client_id', '') IS NOT NULL
  ), grouped AS (
    SELECT nm_lc, MAX(nm) AS sample_name, array_agg(DISTINCT bm_id) AS bm_ids
    FROM rows_in GROUP BY nm_lc
  )
  SELECT jsonb_object_agg(sample_name, to_jsonb(bm_ids))
    INTO duplicate_names
  FROM grouped WHERE cardinality(bm_ids) > 1;

  IF duplicate_refs IS NOT NULL THEN
    SELECT array_agg(k) INTO dup_ref_set FROM jsonb_object_keys(duplicate_refs) k;
  ELSE
    dup_ref_set := ARRAY[]::text[];
  END IF;

  IF duplicate_names IS NOT NULL THEN
    warnings := warnings || jsonb_build_object('duplicate_names', duplicate_names);
  END IF;

  FOR row_input IN SELECT * FROM jsonb_array_elements(payload->'rows')
  LOOP
    BEGIN
      IF NULLIF(row_input->>'bm_client_id', '') IS NULL THEN
        skipped := skipped || jsonb_build_object('bm_client_id', null, 'reason', 'missing bm_client_id (Internal Reference)');
        CONTINUE;
      END IF;
      IF NULLIF(row_input->>'name', '') IS NULL THEN
        skipped := skipped || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'reason', 'missing name');
        CONTINUE;
      END IF;
      IF NULLIF(row_input->>'type', '') IS NULL THEN
        skipped := skipped || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'reason', 'missing/unmapped type');
        CONTINUE;
      END IF;

      -- Sanity gate: refuse to write rows whose Internal Reference is
      -- used by more than one row in this payload. Silent merging via
      -- ON CONFLICT would mis-attribute tasks across two distinct BM
      -- clients (the bug that surfaced on CLA001).
      IF row_input->>'bm_client_id' = ANY (dup_ref_set) THEN
        skipped := skipped || jsonb_build_object(
          'bm_client_id', row_input->>'bm_client_id',
          'reason', format(
            'duplicate bm_client_id %s used by multiple rows in this upload (%s) — fix in BrightManager so each Internal Reference maps to exactly one client',
            row_input->>'bm_client_id',
            (SELECT string_agg(value::text, ', ' ORDER BY value::text) FROM jsonb_array_elements_text(duplicate_refs->(row_input->>'bm_client_id')))
          )
        );
        CONTINUE;
      END IF;

      ent_id := NULL;
      convert_id := NULLIF(row_input->>'convert_prospect_id', '')::uuid;
      cn := NULLIF(row_input->>'company_number', '');
      conflict_id := NULL;
      conflict_bm := NULL;

      IF cn IS NOT NULL THEN
        SELECT id, bm_client_id INTO conflict_id, conflict_bm
        FROM entities
        WHERE company_number = cn
          AND bm_client_id IS DISTINCT FROM (row_input->>'bm_client_id')
          AND id IS DISTINCT FROM convert_id
        LIMIT 1;

        IF conflict_id IS NOT NULL AND conflict_bm IS NOT NULL THEN
          skipped := skipped || jsonb_build_object(
            'bm_client_id', row_input->>'bm_client_id',
            'reason', format('duplicate company_number %s already on bm_client_id %s', cn, conflict_bm)
          );
          CONTINUE;
        END IF;
      END IF;

      IF conflict_id IS NOT NULL AND conflict_bm IS NULL THEN
        UPDATE entities SET
          name                = row_input->>'name',
          type                = (row_input->>'type')::entity_type,
          bm_client_id        = row_input->>'bm_client_id',
          company_number      = cn,
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
        WHERE id = conflict_id
        RETURNING id INTO ent_id;
        orphans_adopted := orphans_adopted + 1;
        entities_written := entities_written + 1;
        CONTINUE;
      END IF;

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
    'orphans_adopted', orphans_adopted,
    'errors', errs,
    'skipped', skipped,
    'warnings', warnings
  );
END;
$function$;
