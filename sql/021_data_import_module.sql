-- ══════════════════════════════════════════════════════════════
-- 021_data_import_module.sql
--
-- Foundations for the Data Import module (UI spec v1.0, 2026-04-15).
--
-- Addresses blockers raised in review of the UI spec:
--   B1  — `import_log` table does not exist (History tab, Status tab
--          "last imported" fields, per-table row counts, errors,
--          approval audit trail all depend on it).
--   B2  — Prospect vs active distinction is implicit in
--          `entities.status text default 'active'`. UI needs a
--          reliable enum-backed split for the Status tab counts
--          and the prospect-conversion panel.
--   B3  — Module access flag `can_import_data` does not exist on
--          `staff_profiles`.
--
-- Decisions locked in for this migration (Bobby + Claude, 2026-04-19):
--   D1  — Permission naming: follow the QuoBu `can_*` convention for
--          module-level gating. New flag is `can_import_data`.
--          The `work_planner` bare-name outlier (§0.9 of
--          DATABASE_SPEC_LIVE.md) is rectified in a separate
--          migration 022 to keep concerns isolated.
--   D2  — Entity status: promote to enum with values
--          (active, prospect, archived). Backfill from existing
--          `entities.status` text; coerce unknown values to 'active'
--          with a NOTICE. Column renamed from `status` to
--          `entity_status` for clarity and to avoid collision with
--          the generic "status" term used elsewhere.
--   D3  — `import_log` is mutable during the workflow
--          (validating → ready → running → complete/failed) but
--          a trigger freezes rows once status ∈ (complete, failed,
--          cancelled). This gives us an audit-grade final record
--          without blocking the progress-tracking UX.
--   D4  — `import_log.errors`, `warnings`, `skipped_rows`,
--          `conversions`, `row_counts` are all JSONB. The UI spec
--          treats these as opaque payloads; the shape is owned by
--          the import pipeline code and versioned in that layer.
--   D5  — No FK from `import_log` to a `sources` lookup table.
--          `source_key` is a text discriminator (e.g. 'bm_clients',
--          'tc_tax_refs'). Keeps adding a new source one code change
--          rather than a migration.
--
-- Open questions deferred to future migrations / code:
--   Q1  — UUID-linkage function (staged service rows) — separate work.
--   Q2  — Tier-3 name-match algorithm + threshold — lives in the
--          validation pipeline, not SQL.
--   Q3  — Concurrent-import lock — enforced in code by checking for
--          any import_log row with status='running' for the same
--          source_key before starting a new one. No DB-level lock
--          needed; the check + insert happen server-side in a tx.
--
-- Run in Supabase SQL Editor against project neksyvneljgxvpchwgch.
-- Single transaction — any failure rolls back the whole migration.
-- ══════════════════════════════════════════════════════════════

BEGIN;


-- ────────────────────────────────────────────────────────────
-- 1. Staff permission flag
-- ────────────────────────────────────────────────────────────

ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS can_import_data boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN staff_profiles.can_import_data IS
  'Gates access to the Admin → Data Import submodule. Grants read/write '
  'on import_log and execute on the import pipeline. Independent of '
  'can_manage_portal / is_portal_admin.';


-- ────────────────────────────────────────────────────────────
-- 2. Entity status enum
-- ────────────────────────────────────────────────────────────

-- 2a. Create enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_status') THEN
    CREATE TYPE entity_status AS ENUM ('active', 'prospect', 'archived');
  END IF;
END $$;

-- 2b. Audit existing text values before coercion
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT status, COUNT(*) AS n
    FROM entities
    WHERE status IS NULL OR status NOT IN ('active','prospect','archived')
    GROUP BY status
  LOOP
    RAISE NOTICE 'entities.status coerce: value=% rows=% → active',
      COALESCE(r.status, '<NULL>'), r.n;
  END LOOP;
END $$;

-- 2c. Add new column, backfill, swap
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS entity_status entity_status;

UPDATE entities
SET entity_status = CASE
  WHEN status = 'prospect' THEN 'prospect'::entity_status
  WHEN status = 'archived' THEN 'archived'::entity_status
  ELSE 'active'::entity_status
END
WHERE entity_status IS NULL;

ALTER TABLE entities
  ALTER COLUMN entity_status SET NOT NULL,
  ALTER COLUMN entity_status SET DEFAULT 'active'::entity_status;

-- 2d. Drop the old text column
-- Anything reading entities.status elsewhere in the code will break at
-- this point — that's intentional. A grep for `entities.status` in the
-- app code should return zero hits before you run this migration.
ALTER TABLE entities DROP COLUMN IF EXISTS status;

CREATE INDEX IF NOT EXISTS idx_entities_entity_status
  ON entities (entity_status);

COMMENT ON COLUMN entities.entity_status IS
  'Lifecycle state. prospect = pre-engagement record (typically from '
  'Athena-side lead intake), active = live client (typically sourced '
  'from BrightManager), archived = former client. Transitions: '
  'prospect → active happens during BrightManager import via the '
  'prospect-conversion flow (Data Import module). active → archived '
  'is manual.';


-- ────────────────────────────────────────────────────────────
-- 3. import_log table
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS import_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identity
  source_key     text        NOT NULL,  -- e.g. 'bm_clients', 'tc_tax_refs'
  file_name      text        NOT NULL,
  file_hash      text        NOT NULL,  -- SHA-256 of uploaded bytes
  file_size      bigint,
  source_row_count integer,             -- rows in the uploaded file

  -- Workflow actors
  triggered_by   uuid        NOT NULL REFERENCES staff_profiles(id),
  triggered_at   timestamptz NOT NULL DEFAULT now(),
  validated_at   timestamptz,
  approved_by    uuid        REFERENCES staff_profiles(id),
  approved_at    timestamptz,
  completed_at   timestamptz,

  -- State machine
  status         text        NOT NULL DEFAULT 'validating'
    CHECK (status IN (
      'validating',   -- file uploaded, validator running or queued
      'ready',        -- validation passed, awaiting approval
      'running',      -- approved, writes in flight
      'complete',     -- all writes succeeded (may include warnings)
      'failed',       -- hard failure during write
      'cancelled'     -- user cancelled before approval, or superseded
    )),

  -- Payloads (shape owned by import pipeline code)
  row_counts     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- e.g. {"entities": 625, "users": 498, "services": 1847}
  warnings       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  skipped_rows   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  conversions    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- prospect → active conversions performed this run
  errors         jsonb       NOT NULL DEFAULT '[]'::jsonb,

  notes          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-source recent-runs lookup (History filter, Status tab "last imported")
CREATE INDEX IF NOT EXISTS idx_import_log_source_triggered
  ON import_log (source_key, triggered_at DESC);

-- Active-run lookup for concurrent-import guard
CREATE INDEX IF NOT EXISTS idx_import_log_source_running
  ON import_log (source_key)
  WHERE status = 'running';

-- File-hash lookup for duplicate-upload detection
CREATE INDEX IF NOT EXISTS idx_import_log_file_hash
  ON import_log (file_hash);

COMMENT ON TABLE import_log IS
  'One row per import run across any source (BrightManager / TaxCalc / '
  'QBO / future). Mutable during the validating→ready→running workflow; '
  'frozen by trg_import_log_freeze_terminal once status enters a '
  'terminal state (complete, failed, cancelled).';


-- ────────────────────────────────────────────────────────────
-- 4. Terminal-state immutability trigger
-- ────────────────────────────────────────────────────────────

-- Follows the pattern of prevent_qbo_sync_log_modification() etc., but
-- scoped to rows that have reached a terminal status rather than the
-- whole table. This is what gives us the audit-grade guarantee without
-- blocking normal workflow progression.

CREATE OR REPLACE FUNCTION fn_import_log_freeze_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('complete','failed','cancelled') THEN
      RAISE EXCEPTION 'import_log row in terminal status (%) cannot be deleted', OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status IN ('complete','failed','cancelled')
     AND NEW.status = OLD.status THEN
    -- Permit only `notes` edits on terminal rows. Everything else frozen.
    IF NEW.id              IS DISTINCT FROM OLD.id              OR
       NEW.source_key      IS DISTINCT FROM OLD.source_key      OR
       NEW.file_name       IS DISTINCT FROM OLD.file_name       OR
       NEW.file_hash       IS DISTINCT FROM OLD.file_hash       OR
       NEW.file_size       IS DISTINCT FROM OLD.file_size       OR
       NEW.source_row_count IS DISTINCT FROM OLD.source_row_count OR
       NEW.triggered_by    IS DISTINCT FROM OLD.triggered_by    OR
       NEW.triggered_at    IS DISTINCT FROM OLD.triggered_at    OR
       NEW.validated_at    IS DISTINCT FROM OLD.validated_at    OR
       NEW.approved_by     IS DISTINCT FROM OLD.approved_by     OR
       NEW.approved_at     IS DISTINCT FROM OLD.approved_at     OR
       NEW.completed_at    IS DISTINCT FROM OLD.completed_at    OR
       NEW.row_counts      IS DISTINCT FROM OLD.row_counts      OR
       NEW.warnings        IS DISTINCT FROM OLD.warnings        OR
       NEW.skipped_rows    IS DISTINCT FROM OLD.skipped_rows    OR
       NEW.conversions     IS DISTINCT FROM OLD.conversions     OR
       NEW.errors          IS DISTINCT FROM OLD.errors          OR
       NEW.created_at      IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'import_log row % is in terminal status (%) — only `notes` may be edited',
        OLD.id, OLD.status;
    END IF;
  END IF;

  -- Illegal state transitions (forward-only, with cancelled reachable
  -- from validating/ready only).
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'validating' AND NEW.status IN ('ready','failed','cancelled')) OR
      (OLD.status = 'ready'      AND NEW.status IN ('running','cancelled','validating')) OR
      (OLD.status = 'running'    AND NEW.status IN ('complete','failed'))
    ) THEN
      RAISE EXCEPTION 'illegal import_log status transition: % → %', OLD.status, NEW.status;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_import_log_freeze_terminal ON import_log;
CREATE TRIGGER trg_import_log_freeze_terminal
  BEFORE UPDATE OR DELETE ON import_log
  FOR EACH ROW EXECUTE FUNCTION fn_import_log_freeze_terminal();


-- ────────────────────────────────────────────────────────────
-- 5. RLS
-- ────────────────────────────────────────────────────────────

ALTER TABLE import_log ENABLE ROW LEVEL SECURITY;

-- Read: any staff member with can_import_data, OR portal admin.
DROP POLICY IF EXISTS import_log_read ON import_log;
CREATE POLICY import_log_read ON import_log
  FOR SELECT
  TO authenticated
  USING (
    is_portal_admin()
    OR COALESCE(
      (SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()),
      false
    )
  );

-- Write (insert/update): same gate. Deletes are blocked for terminal
-- rows by the trigger; for non-terminal rows, only the triggering
-- staff member OR a portal admin may delete (lets a user cancel their
-- own in-flight import).
DROP POLICY IF EXISTS import_log_insert ON import_log;
CREATE POLICY import_log_insert ON import_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_portal_admin()
    OR COALESCE(
      (SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()),
      false
    )
  );

DROP POLICY IF EXISTS import_log_update ON import_log;
CREATE POLICY import_log_update ON import_log
  FOR UPDATE
  TO authenticated
  USING (
    is_portal_admin()
    OR COALESCE(
      (SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()),
      false
    )
  )
  WITH CHECK (
    is_portal_admin()
    OR COALESCE(
      (SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()),
      false
    )
  );

DROP POLICY IF EXISTS import_log_delete ON import_log;
CREATE POLICY import_log_delete ON import_log
  FOR DELETE
  TO authenticated
  USING (
    is_portal_admin()
    OR triggered_by = auth.uid()
  );


-- ────────────────────────────────────────────────────────────
-- 6. updated_at maintenance
-- ────────────────────────────────────────────────────────────
-- The freeze-terminal trigger already bumps updated_at on every UPDATE,
-- so we deliberately do NOT wire set_updated_at() here — that would
-- double-fire.


COMMIT;

-- ══════════════════════════════════════════════════════════════
-- Verification queries (run after commit)
-- ══════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'import_log' ORDER BY ordinal_position;
--
-- SELECT entity_status, COUNT(*) FROM entities GROUP BY entity_status;
--
-- SELECT can_import_data, COUNT(*) FROM staff_profiles GROUP BY 1;
