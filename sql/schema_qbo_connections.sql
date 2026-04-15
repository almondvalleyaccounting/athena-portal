-- qbo_connections — QuickBooks Online OAuth connection store
-- One row per connected QBO company (realm)
-- Protected: do not modify without explicit instruction

CREATE TABLE qbo_connections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  realm_id                 TEXT NOT NULL,
  company_name             TEXT,
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  token_expires_at         TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ,
  scope                    TEXT,
  connected_by             UUID,
  connected_at             TIMESTAMPTZ DEFAULT now(),
  last_refreshed_at        TIMESTAMPTZ,
  status                   TEXT DEFAULT 'active',
  error_message            TEXT,
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now()
);
