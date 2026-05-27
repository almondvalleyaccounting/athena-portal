-- Enable Row-Level Security on three tables flagged by the Supabase
-- security advisor (rls_disabled_in_public + sensitive_columns_exposed).
-- Without RLS these were reachable by the anon API key, exposing data
-- and — for gmail_connections — OAuth access/refresh tokens.
--
-- Edge functions use the service-role key and bypass RLS, so their
-- writes (qbo-pull upserts qbo_items; gmail-* manage gmail_connections)
-- are unaffected. Policies below cover the frontend (authenticated staff).

-- ── gmail_connections ────────────────────────────────────────────────
-- Token store; mirror qbo_connections: admins manage, active staff read.
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_connections_admin_manage ON gmail_connections;
CREATE POLICY gmail_connections_admin_manage ON gmail_connections
  FOR ALL TO authenticated
  USING (is_portal_admin()) WITH CHECK (is_portal_admin());

DROP POLICY IF EXISTS gmail_connections_staff_read ON gmail_connections;
CREATE POLICY gmail_connections_staff_read ON gmail_connections
  FOR SELECT TO authenticated
  USING (is_active_staff());

-- ── billing_service_mappings ─────────────────────────────────────────
-- Read + upsert from the Billing module; active staff manage.
ALTER TABLE billing_service_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_service_mappings_read ON billing_service_mappings;
CREATE POLICY billing_service_mappings_read ON billing_service_mappings
  FOR SELECT TO authenticated
  USING (is_active_staff());

DROP POLICY IF EXISTS billing_service_mappings_manage ON billing_service_mappings;
CREATE POLICY billing_service_mappings_manage ON billing_service_mappings
  FOR ALL TO authenticated
  USING (is_active_staff()) WITH CHECK (is_active_staff());

-- ── qbo_items ────────────────────────────────────────────────────────
-- QBO Item catalog mirror; read-only from the frontend, written by the
-- qbo-pull edge function (service role). Active staff read; manage kept
-- for parity / any future client-side maintenance.
ALTER TABLE qbo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_items_read ON qbo_items;
CREATE POLICY qbo_items_read ON qbo_items
  FOR SELECT TO authenticated
  USING (is_active_staff());

DROP POLICY IF EXISTS qbo_items_manage ON qbo_items;
CREATE POLICY qbo_items_manage ON qbo_items
  FOR ALL TO authenticated
  USING (is_active_staff()) WITH CHECK (is_active_staff());
