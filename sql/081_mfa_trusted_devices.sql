-- 081_mfa_trusted_devices.sql
-- Per-user "remember this device" tokens for MFA. After a successful TOTP
-- verification (challenge or enrolment), the client stores a random token
-- and inserts its sha-256 hash here with a 90-day expiry. On subsequent
-- visits within that window the app skips the 6-digit prompt for that
-- device.

CREATE TABLE IF NOT EXISTS mfa_trusted_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  user_agent    text,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_trusted_devices_user ON mfa_trusted_devices (user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_trusted_devices_lookup ON mfa_trusted_devices (user_id, token_hash);

ALTER TABLE mfa_trusted_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_trusted_devices_select ON mfa_trusted_devices;
CREATE POLICY mfa_trusted_devices_select ON mfa_trusted_devices
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS mfa_trusted_devices_insert ON mfa_trusted_devices;
CREATE POLICY mfa_trusted_devices_insert ON mfa_trusted_devices
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS mfa_trusted_devices_update ON mfa_trusted_devices;
CREATE POLICY mfa_trusted_devices_update ON mfa_trusted_devices
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS mfa_trusted_devices_delete ON mfa_trusted_devices;
CREATE POLICY mfa_trusted_devices_delete ON mfa_trusted_devices
  FOR DELETE USING (user_id = auth.uid());
