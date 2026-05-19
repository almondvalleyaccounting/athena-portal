-- 073_bm_primary_contact_and_qbo_email.sql
-- Extend the contact data model so the fee-raise email can address the
-- person (not the company) and offer every known email address as a
-- candidate recipient.
--
-- Three concrete additions:
--   1. people.first_name / last_name / preferred_name
--        BM gives us First Name, Last Name, and Preferred Name as
--        separate columns. Preferred Name is what the client actually
--        wants to be called (overrides First Name).
--   2. qbo_customer_mappings.qbo_email
--        QBO Customer.PrimaryEmailAddr.Address can pack several
--        addresses into one string (comma- or semicolon-separated).
--        Stored raw; the UI splits at display time.
--   3. import_bm_clients RPC now upserts a primary-contact `people` row
--        and links it via entity_people (role='contact',
--        is_primary_contact=true, source='brightmanager').

BEGIN;

-- 1. people: new name columns
ALTER TABLE people ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS preferred_name text;

-- 2. people.source: extend CHECK to allow 'brightmanager'
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_source_check;
ALTER TABLE people ADD CONSTRAINT people_source_check
  CHECK (source IN ('manual','ch_officer','ch_psc','sole_trader_auto','partnership_auto','brightmanager'));

-- 3. entity_people.source: same widening
ALTER TABLE entity_people DROP CONSTRAINT IF EXISTS entity_people_source_check;
ALTER TABLE entity_people ADD CONSTRAINT entity_people_source_check
  CHECK (source IN ('manual','ch_officers','ch_psc','sole_trader_auto','partnership_auto','brightmanager'));

-- 4. qbo_customer_mappings.qbo_email
ALTER TABLE qbo_customer_mappings ADD COLUMN IF NOT EXISTS qbo_email text;

-- 5. Refresh import_bm_clients to also persist the primary contact.
--    Re-import is the only place this gets touched; the existing path
--    is preserved verbatim and the person upsert tacked on at the end
--    of each row's processing.
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
  people_upserted int := 0;
  -- Per-row primary-contact scratch
  bm_first text;
  bm_last  text;
  bm_pref  text;
  bm_email text;
  bm_full  text;
  existing_person uuid;
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
        END IF;
      END IF;

      IF ent_id IS NULL THEN
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
      END IF;

      -- Primary-contact upsert. Only act when BM gave us at least one
      -- person field; otherwise we'd insert a row of nulls.
      bm_first := NULLIF(row_input->>'_primary_first_name', '');
      bm_last  := NULLIF(row_input->>'_primary_last_name', '');
      bm_pref  := NULLIF(row_input->>'_primary_preferred_name', '');
      bm_email := NULLIF(row_input->>'_primary_email', '');
      bm_full  := NULLIF(row_input->>'_primary_name', '');

      IF ent_id IS NOT NULL AND (bm_first IS NOT NULL OR bm_last IS NOT NULL OR bm_pref IS NOT NULL OR bm_full IS NOT NULL) THEN
        -- One BM-sourced primary contact per entity. Reuse the existing
        -- linked person if any; otherwise create a fresh people row and
        -- link it.
        SELECT person_id INTO existing_person
          FROM entity_people
         WHERE entity_id = ent_id
           AND source = 'brightmanager'
           AND is_primary_contact = true
         LIMIT 1;

        IF existing_person IS NOT NULL THEN
          UPDATE people SET
            name           = COALESCE(bm_full, name),
            first_name     = COALESCE(bm_first, first_name),
            last_name      = COALESCE(bm_last, last_name),
            preferred_name = COALESCE(bm_pref, preferred_name),
            email          = COALESCE(bm_email, email),
            source         = 'brightmanager',
            updated_at     = now()
          WHERE id = existing_person;
        ELSE
          INSERT INTO people (name, first_name, last_name, preferred_name, email, source)
          VALUES (
            COALESCE(bm_full, NULLIF(trim(concat_ws(' ', bm_first, bm_last)), ''), bm_pref, '(unknown)'),
            bm_first, bm_last, bm_pref, bm_email, 'brightmanager'
          )
          RETURNING id INTO existing_person;

          INSERT INTO entity_people (entity_id, person_id, role, is_primary_contact, source)
          VALUES (ent_id, existing_person, 'contact', true, 'brightmanager')
          ON CONFLICT (entity_id, person_id, role) DO UPDATE SET is_primary_contact = true;
        END IF;
        people_upserted := people_upserted + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      errs := errs || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'message', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'entities_written', entities_written,
    'prospects_converted', prospects_converted,
    'people_upserted', people_upserted,
    'errors', errs,
    'skipped', skipped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION import_bm_clients(uuid, jsonb) TO authenticated;

COMMIT;
