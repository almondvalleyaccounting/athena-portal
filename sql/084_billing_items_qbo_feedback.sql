-- Billing module: QBO invoice feedback loop.
--
-- After a billing_item is pushed we confirm, from QuickBooks, the invoice
-- number it was assigned and whether it has actually been emailed, and
-- tag that back against the bill.
--
--   qbo_doc_number     - the human-facing QBO invoice number (DocNumber),
--                        e.g. "1037". Distinct from qbo_invoice_id (the
--                        internal QBO Id).
--   qbo_email_status   - QBO's own EmailStatus: 'EmailSent' | 'NeedToSend'
--                        | 'NotSet'. The real send state, not just whether
--                        we asked QBO to send.
--   qbo_last_checked_at - when we last re-confirmed these from QBO.

alter table billing_items
  add column if not exists qbo_doc_number text,
  add column if not exists qbo_email_status text,
  add column if not exists qbo_last_checked_at timestamptz;
