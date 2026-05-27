-- QBO push tracking for the one-off Billing module (billing_items).
-- Until now "Push to QB" only flipped status='pushed' locally; these
-- columns let us record the real QBO invoice created for each item and
-- whether it was sent or left as a draft.
alter table billing_items
  add column if not exists qbo_invoice_id text,
  add column if not exists qbo_customer_id text,
  add column if not exists qbo_sync_status text,   -- 'synced' | 'error' | 'created_unsent'
  add column if not exists qbo_synced_at timestamptz,
  add column if not exists qbo_sync_error text,
  add column if not exists pushed_by uuid,
  add column if not exists pushed_at timestamptz;
