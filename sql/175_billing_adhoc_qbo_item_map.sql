-- 175: Point the ad-hoc bill services at real QBO products.
--
-- Problem: qbo-push-billing-items resolves a line's service through
-- qbo_service_items, and if that misses it falls back to an exact QBO
-- Item.Name lookup. Most /billing dropdown labels ('Accounts Production',
-- 'Bookkeeping', 'Advisory'…) had no map row, so the fallback found the
-- throwaway items the OLD auto-create path had left behind in QBO —
-- items 41-46, which sit on the catch-all Billable Expense Income
-- account. Invoices posted fine; the revenue coded to the wrong account.
--
-- This maps the unambiguous labels onto the established products.
-- 'Admin', 'Advisory', 'Company Secretarial', 'SA302s' and
-- 'Accountant Certificates' are deliberately NOT set here — they need a
-- decision on which income item they belong to.
--
-- is_adhoc marks rows that exist only to resolve a free-text bill line.
-- The quote-vs-live comparison reverse-maps QBO item name -> Athena
-- service id, and these rows deliberately duplicate an existing item
-- name (two services -> item 13), which would make that reverse map
-- ambiguous. Readers of the reverse map filter is_adhoc = false.

alter table public.qbo_service_items
  add column if not exists is_adhoc boolean not null default false;

comment on column public.qbo_service_items.is_adhoc is
  'True for rows that map an ad-hoc /billing line label to a QBO product. Excluded from the quote-vs-live reverse map, which needs one canonical service per QBO item.';

-- The fee-engine service ids are the canonical side of the reverse map.
-- 'Admin' (sql/145) is an ad-hoc label like the ones added below.
update public.qbo_service_items set is_adhoc = true where service_id = 'Admin';

insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, default_description, is_adhoc)
values
  ('Accounts Production', '13', 'Annual Statutory Accounts & Business Tax', 'Accounts production', true),
  ('Corporation Tax',     '13', 'Annual Statutory Accounts & Business Tax', 'Corporation tax return', true),
  ('Self Assessment',     '14', 'Self Assessment Tax Return',              'Self Assessment tax return', true),
  ('VAT Returns',         '22', 'Bookkeeping & VAT Returns',               'VAT returns', true),
  ('Bookkeeping',         '22', 'Bookkeeping & VAT Returns',               'Bookkeeping', true)
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      is_adhoc = true,
      default_description = coalesce(public.qbo_service_items.default_description, excluded.default_description);
