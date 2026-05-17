-- Fee uplift review pipeline.
--
-- A staged uplift (pending_monthly_amount on a service) needs to be
-- reviewed at the template/client level before we POST to QBO. The
-- review is row-level (per live_billing row = per QBO template) since
-- the user's mental model is "approve this client's raise" not "approve
-- this service line".
--
-- qbo_next_run_date is fetched on demand from QBO RecurringInfo.NextDate
-- and cached here so the review screen can show when the new amounts
-- will first be invoiced.
ALTER TABLE live_billing
  ADD COLUMN IF NOT EXISTS qbo_next_run_date date,
  ADD COLUMN IF NOT EXISTS uplift_review_status text CHECK (uplift_review_status IN ('staged', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS uplift_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS uplift_reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS live_billing_uplift_review_status_idx
  ON live_billing (uplift_review_status)
  WHERE uplift_review_status IS NOT NULL;
