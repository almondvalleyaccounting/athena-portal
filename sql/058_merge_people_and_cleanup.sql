-- 058_merge_people_and_cleanup.sql
-- a) merge_people(source_id, target_id) — RPC for the manual person merge UI.
-- b) Replace capacity_shifts schema: drop allocation_id (we don't use the
--    allocations table any more), key shifts by staff + month so any chunk
--    of capacity can be moved.
-- c) Drop client_service_allocations table — superseded by BM inference +
--    allocation_changes (proposals only). Cleans up the dead override path.

-- ── 1. merge_people ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_people(source_id uuid, target_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src_record people%ROWTYPE;
BEGIN
  IF source_id = target_id THEN RETURN; END IF;

  SELECT * INTO src_record FROM people WHERE id = source_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Drop conflicting source rows (target wins on (entity, role)).
  DELETE FROM entity_people sp
   WHERE sp.person_id = source_id
     AND EXISTS (
       SELECT 1 FROM entity_people tp
        WHERE tp.person_id = target_id
          AND tp.entity_id = sp.entity_id
          AND tp.role      = sp.role
     );

  -- Move remaining source links to target.
  UPDATE entity_people SET person_id = target_id WHERE person_id = source_id;
  UPDATE entities      SET linked_person_id = target_id WHERE linked_person_id = source_id;

  -- Delete source first to free unique constraints on ch_officer_id / ch_psc_id.
  DELETE FROM people WHERE id = source_id;

  -- Backfill missing fields onto target from snapshot.
  UPDATE people
     SET ch_officer_id = COALESCE(ch_officer_id, src_record.ch_officer_id),
         ch_psc_id     = COALESCE(ch_psc_id,     src_record.ch_psc_id),
         dob_year      = COALESCE(dob_year,      src_record.dob_year),
         dob_month     = COALESCE(dob_month,     src_record.dob_month),
         ni_number     = COALESCE(ni_number,     src_record.ni_number),
         email         = COALESCE(email,         src_record.email),
         updated_at    = now()
   WHERE id = target_id;
END $$;

GRANT EXECUTE ON FUNCTION merge_people(uuid, uuid) TO authenticated;

-- ── 2. capacity_shifts re-shaped ──────────────────────────────────────
-- Drop the existing table (it had no committed data and the FK to
-- client_service_allocations is going away below).
DROP TABLE IF EXISTS capacity_shifts;

CREATE TABLE capacity_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  source_month date NOT NULL,        -- first of the month
  target_month date NOT NULL,
  hours numeric NOT NULL CHECK (hours > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','committed','discarded')),
  note text,
  created_by uuid REFERENCES staff_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE INDEX capacity_shifts_staff_idx        ON capacity_shifts (staff_id);
CREATE INDEX capacity_shifts_target_month_idx ON capacity_shifts (target_month);

ALTER TABLE capacity_shifts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "capacity_shifts_all" ON capacity_shifts;
CREATE POLICY "capacity_shifts_all" ON capacity_shifts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 3. Drop the dead client_service_allocations table ────────────────
-- Empty in dev; superseded by BM inference + allocation_changes.
DROP TABLE IF EXISTS client_service_allocations CASCADE;
