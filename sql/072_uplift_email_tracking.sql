-- Mark when (and by whom) the fee-raise email for a row was sent, so
-- the Push tab can show an "emailed" indicator and avoid duplicate
-- sends.
ALTER TABLE live_billing
  ADD COLUMN IF NOT EXISTS uplift_email_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS uplift_email_sent_by  uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uplift_email_to       text;
