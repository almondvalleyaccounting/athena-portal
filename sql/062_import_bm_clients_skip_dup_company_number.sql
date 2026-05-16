-- Pre-check for duplicate company_number inside import_bm_clients so a single
-- bad row doesn't bubble entities_company_number_uniq up as a row-level error.
-- If the incoming company_number already belongs to a different bm_client_id
-- (or appears twice in the same payload), skip that row with a clear reason.

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
  existing_bm text;
  errs jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  entities_written int := 0;
  prospects_converted int := 0;
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

      ent_id := NULL;
      convert_id := NULLIF(row_input->>'convert_prospect_id', '')::uuid;
      cn := NULLIF(row_input->>'company_number', '');

      -- Guard against the entities_company_number_uniq index. If the incoming
      -- company_number already belongs to a *different* bm_client_id, skip
      -- the row with a clear reason rather than failing the whole insert.
      IF cn IS NOT NULL THEN
        SELECT bm_client_id INTO existing_bm
        FROM entities
        WHERE company_number = cn
          AND bm_client_id IS DISTINCT FROM (row_input->>'bm_client_id')
          AND id IS DISTINCT FROM convert_id
        LIMIT 1;
        IF existing_bm IS NOT NULL THEN
          skipped := skipped || jsonb_build_object(
            'bm_client_id', row_input->>'bm_client_id',
            'reason', format('duplicate company_number %s already on bm_client_id %s', cn, COALESCE(existing_bm, '(no bm_client_id)'))
          );
          CONTINUE;
        END IF;
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
    'errors', errs,
    'skipped', skipped
  );
END;
$function$;
