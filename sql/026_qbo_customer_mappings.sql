-- ══════════════════════════════════════════════════════════════
-- 026_qbo_customer_mappings.sql
--
-- Many-to-one mapping from QBO customer → Athena entity.
-- QBO ID is the primary key (stable; survives QBO-side name changes).
-- Multiple QBO rows can point at the same entity (primary client,
-- billing-initiator, legacy record). Unmapped rows (entity_id null)
-- are a valid state — the mapping UI exists to resolve them.
--
-- Applied to live via MCP 2026-04-19. Backfilled 0 rows (no entity
-- had qbo_customer_id populated at the time).
-- ══════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS qbo_customer_mappings (
  qbo_customer_id   text PRIMARY KEY,
  entity_id         uuid REFERENCES entities(id) ON DELETE SET NULL,
  qbo_customer_name text,
  role              text NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary','legacy','billing_initiator','not_a_client')),
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qbo_mappings_entity
  ON qbo_customer_mappings (entity_id);
CREATE INDEX IF NOT EXISTS idx_qbo_mappings_unmapped
  ON qbo_customer_mappings (qbo_customer_id)
  WHERE entity_id IS NULL;

INSERT INTO qbo_customer_mappings (qbo_customer_id, entity_id, qbo_customer_name, role)
SELECT qbo_customer_id, id, qbo_customer_name, 'primary'
FROM entities
WHERE qbo_customer_id IS NOT NULL
ON CONFLICT (qbo_customer_id) DO NOTHING;

ALTER TABLE qbo_customer_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_mappings_read ON qbo_customer_mappings;
CREATE POLICY qbo_mappings_read ON qbo_customer_mappings
  FOR SELECT TO authenticated USING (is_active_staff());

DROP POLICY IF EXISTS qbo_mappings_manage ON qbo_customer_mappings;
CREATE POLICY qbo_mappings_manage ON qbo_customer_mappings
  FOR ALL TO authenticated
  USING (is_active_staff()) WITH CHECK (is_active_staff());

DROP TRIGGER IF EXISTS trg_qbo_mappings_updated_at ON qbo_customer_mappings;
CREATE TRIGGER trg_qbo_mappings_updated_at
  BEFORE UPDATE ON qbo_customer_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE qbo_customer_mappings IS
  'Many-to-one map from QBO customer id to Athena entity. QBO id is the stable key; names change over time so qbo_customer_name is metadata only.';

COMMIT;
