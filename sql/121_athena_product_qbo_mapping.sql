-- 121: Athena product → QBO product mapping + standard fees.
--
-- Two tables behind the new Billing Review tabs:
--   * athena_product_qbo_map — maps each Athena service/product id (the
--     service_id values used across live_billing / billing_service_mappings,
--     plus the canonical capacity-planner services) to a QBO Item from the
--     qbo_items catalog mirror (populated by qbo-pull). Readable by all
--     active staff (it holds no client fees, only catalog wiring); written
--     by billing operators (can_view_billing) and fee admins
--     (can_view_client_fees).
--   * standard_fees — the admin-only price book: a named task mapped to an
--     Athena product with a standard net fee. Fee data, so both read and
--     write are gated to can_view_client_fees() (same tier as live_billing
--     in sql/108).
--
-- Policy style mirrors sql/077 (DROP POLICY IF EXISTS + FOR ALL TO
-- authenticated with WITH CHECK mirroring USING).

-- ── athena_product_qbo_map ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS athena_product_qbo_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  text NOT NULL UNIQUE,
  qbo_item_id text NOT NULL,
  notes       text,
  updated_by  uuid REFERENCES staff_profiles(id),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS athena_product_qbo_map_item_idx
  ON athena_product_qbo_map (qbo_item_id);

ALTER TABLE athena_product_qbo_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS athena_product_qbo_map_read ON athena_product_qbo_map;
CREATE POLICY athena_product_qbo_map_read ON athena_product_qbo_map
  FOR SELECT TO authenticated
  USING (is_active_staff());

-- Writers: billing operators or fee admins (fee admins included so
-- Bobby/Tracy/Yvonne aren't blocked if they lack the billing flag).
DROP POLICY IF EXISTS athena_product_qbo_map_manage ON athena_product_qbo_map;
CREATE POLICY athena_product_qbo_map_manage ON athena_product_qbo_map
  FOR ALL TO authenticated
  USING (
    can_view_client_fees()
    OR EXISTS (
      SELECT 1 FROM staff_profiles
      WHERE id = auth.uid() AND is_active = true AND can_view_billing = true
    )
  )
  WITH CHECK (
    can_view_client_fees()
    OR EXISTS (
      SELECT 1 FROM staff_profiles
      WHERE id = auth.uid() AND is_active = true AND can_view_billing = true
    )
  );

-- ── standard_fees ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS standard_fees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_name    text NOT NULL,
  service_id   text NOT NULL,
  standard_net numeric(10,2) NOT NULL DEFAULT 0,
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS standard_fees_service_idx
  ON standard_fees (service_id);

ALTER TABLE standard_fees ENABLE ROW LEVEL SECURITY;

-- Fee data: read AND write restricted to can_view_client_fees()
-- (single FOR ALL policy covers SELECT/INSERT/UPDATE/DELETE).
DROP POLICY IF EXISTS standard_fees_manage ON standard_fees;
CREATE POLICY standard_fees_manage ON standard_fees
  FOR ALL TO authenticated
  USING (can_view_client_fees())
  WITH CHECK (can_view_client_fees());
