-- live_billing — committed billing records from quotes pushed to live
-- Referenced by: HomeScreen.jsx (weekly fees stat)
-- Protected: do not modify without explicit instruction

CREATE TABLE live_billing (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             UUID NOT NULL,
  quote_id              UUID NOT NULL,
  qbo_invoice_id        TEXT,
  qbo_recurring_id      TEXT,
  qbo_recurring_txn_id  TEXT,
  qbo_customer_id       TEXT,
  qbo_sync_status       TEXT,
  billing_type          TEXT DEFAULT 'recurring',
  status                TEXT DEFAULT 'active',
  monthly_net           NUMERIC,
  monthly_vat           NUMERIC,
  monthly_gross         NUMERIC,
  annual_total          NUMERIC,
  services              JSONB DEFAULT '[]',
  committed_at          TIMESTAMPTZ,
  committed_by          UUID,
  last_synced_qbo       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
