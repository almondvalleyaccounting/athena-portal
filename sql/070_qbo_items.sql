-- Cache of QBO Items (a.k.a. products/services). Mirrors the QBO
-- catalog so the Add Billing flow can offer real QBO services in the
-- dropdown, and so a future qbo-push-recurring can reference each
-- line by its true ItemRef.value rather than re-resolving by name.
CREATE TABLE IF NOT EXISTS qbo_items (
  qbo_item_id   text PRIMARY KEY,
  name          text NOT NULL,
  fully_qualified_name text,
  description   text,
  type          text,
  unit_price    numeric(12, 2),
  active        boolean NOT NULL DEFAULT true,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qbo_items_name_idx       ON qbo_items (name);
CREATE INDEX IF NOT EXISTS qbo_items_active_idx     ON qbo_items (active);
