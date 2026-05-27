-- 037_client_service_allocations.sql
-- Links a staff member (fee earner) and a manager to each
-- client × service combination. Populated at commit-to-live time from
-- the CommitToLiveModal, editable later from the client detail page.
--
-- Deliberately separate from live_billing.services and entity_fees —
-- "who owns the work" is orthogonal to "how much, how often". A service
-- can have zero billing and still be owned by someone (pre-billing
-- setup); allocations shouldn't churn when billing is approved/rejected.

CREATE TABLE IF NOT EXISTS client_service_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  service_id             text NOT NULL,
  fee_earner_id          uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  fee_earner_manager_id  uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_service_allocations_unique UNIQUE (entity_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_csa_fee_earner
  ON client_service_allocations (fee_earner_id);

CREATE INDEX IF NOT EXISTS idx_csa_fee_earner_manager
  ON client_service_allocations (fee_earner_manager_id);

CREATE INDEX IF NOT EXISTS idx_csa_entity
  ON client_service_allocations (entity_id);

-- Touch-trigger for updated_at
CREATE OR REPLACE FUNCTION touch_csa_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_csa_touch ON client_service_allocations;
CREATE TRIGGER trg_csa_touch BEFORE UPDATE ON client_service_allocations
  FOR EACH ROW EXECUTE FUNCTION touch_csa_updated_at();

COMMENT ON TABLE client_service_allocations IS
  'Per client × service allocation of a fee earner and their manager. Used for practice-wide fee attribution reports.';

-- RLS: mirror entity_fees posture (written in the same commit-to-live flow).
ALTER TABLE client_service_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_service_allocations_select ON client_service_allocations;
CREATE POLICY client_service_allocations_select ON client_service_allocations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM staff_profiles
            WHERE staff_profiles.id = auth.uid()
              AND staff_profiles.can_view_client_fees = true)
  );

DROP POLICY IF EXISTS client_service_allocations_insert ON client_service_allocations;
CREATE POLICY client_service_allocations_insert ON client_service_allocations
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM staff_profiles
            WHERE staff_profiles.id = auth.uid()
              AND (staff_profiles.can_edit_quotes = true OR staff_profiles.can_manage_portal = true))
  );

DROP POLICY IF EXISTS client_service_allocations_update ON client_service_allocations;
CREATE POLICY client_service_allocations_update ON client_service_allocations
  FOR UPDATE USING (true) WITH CHECK (
    EXISTS (SELECT 1 FROM staff_profiles
            WHERE staff_profiles.id = auth.uid()
              AND (staff_profiles.can_edit_quotes = true OR staff_profiles.can_manage_portal = true))
  );
