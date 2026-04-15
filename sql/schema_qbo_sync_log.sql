-- qbo_sync_log — audit trail for QBO push/pull operations
-- Protected: do not modify without explicit instruction

CREATE TABLE qbo_sync_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction         TEXT NOT NULL,              -- 'push' or 'pull'
  entity_id         UUID,
  entity_name       TEXT,
  qbo_entity_type   TEXT,                       -- e.g. 'Invoice', 'RecurringTransaction'
  qbo_entity_id     TEXT,
  status            TEXT NOT NULL,              -- 'success', 'error', etc.
  detail            JSONB DEFAULT '{}',
  error_message     TEXT,
  initiated_by      UUID,
  created_at        TIMESTAMPTZ DEFAULT now()
);
