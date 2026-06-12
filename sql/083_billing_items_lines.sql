-- Billing module: multi-line invoices.
--
-- A billing_item can now carry several lines so one client gets a single
-- multi-line QBO invoice instead of one invoice per service. The lines
-- array holds the per-line breakdown; the row's net_amount/vat_amount/
-- gross_amount remain the invoice totals (sum of the lines) and `service`
-- becomes a short display summary.
--
-- Each element: { service, description, net, vat, gross }
--
-- Legacy rows (lines IS NULL) are treated as a single line built from the
-- existing service/description/net_amount fields, so nothing breaks.

alter table billing_items
  add column if not exists lines jsonb;

comment on column billing_items.lines is
  'Multi-line invoice breakdown: array of { service, description, net, vat, gross }. NULL = single legacy line from service/net_amount.';
