-- 189: The QuickBooks parent category for each mapped service.
--
-- The ask (Bobby, 2026-08-06): the service dropdown on a bill is a flat list of
-- 32 names — make it searchable, and group it the way QuickBooks groups the
-- products. QBO's catalogue is a tree (sql/176, the 2026-08-04 rebuild): eight
-- top-level grouping items with the billable leaves hung underneath. Athena's
-- map held only the leaf name, so the dropdown had nothing to group by.
--
-- Values below are the live QBO hierarchy as read back on 2026-08-06 — the
-- fully-qualified names QBO reports, e.g.
--
--     Accounts:Business Accounts - Ltd Companies
--     All Inclusive:All Inclusive Fees - Ltd Companies:All Inclusive Fees - Ltd Companies (VAT Registered)
--
-- Stored per item is the TOP-LEVEL ancestor, not the immediate parent: the two
-- All Inclusive Ltd leaves sit a level deeper inside their own grouping item,
-- and a picker that grouped by immediate parent would show a category holding
-- one entry. Nesting that the invoice never shows isn't worth a heading.
--
-- Keyed on qbo_item_name rather than service_id because the category belongs to
-- the QBO product, and several service ids share one product — 'Bookkeeping'
-- and 'VAT Returns' are both item #22, 'Self Assessment' and
-- 'directors_tax_return' are both #14. Naming the product once keeps them from
-- drifting into different categories.
--
-- This is a cache of QBO's shape, not a second authority: nothing reads it to
-- decide where revenue codes, and the push still resolves the item by name
-- through qbo_service_items. It only decides which heading a service appears
-- under in the dropdown. If the catalogue is re-parented in QBO, re-run the
-- update below with the new grouping.

alter table public.qbo_service_items
  add column if not exists qbo_category text;

comment on column public.qbo_service_items.qbo_category is
  'Top-level QuickBooks grouping item this product hangs under (Accounts, Tax '
  'Returns, Bookkeeping, Payroll Related, Advisory, Company Secretarial, All '
  'Inclusive, Other). Presentation only — groups the service picker. Cached '
  'from QBO, not an authority on where revenue codes.';

update public.qbo_service_items s
set qbo_category = m.category
from (values
  -- Accounts
  ('Business Accounts and Corporation Tax Combined', 'Accounts'),
  ('Business Accounts - Ltd Companies',              'Accounts'),
  ('Business Accounts - LLP',                        'Accounts'),
  ('Business Accounts - Partnership',                'Accounts'),
  ('Business Accounts - Property',                   'Accounts'),
  ('Business Accounts - Sole Trader',                'Accounts'),
  ('Business Accounts - Dormant Ltd Company',        'Accounts'),
  -- Tax Returns
  ('Tax Returns - Individual',                       'Tax Returns'),
  ('Tax Returns - Ltd Company (CT600)',              'Tax Returns'),
  ('Tax Returns - LLP',                              'Tax Returns'),
  ('Tax Returns - Partnership (SA800)',              'Tax Returns'),
  ('Tax Returns - MTD',                              'Tax Returns'),
  -- Bookkeeping
  ('Bookkeeping (VAT Registered)',                   'Bookkeeping'),
  ('Bookkeeping (non-VAT registered)',               'Bookkeeping'),
  -- Payroll Related
  ('Payroll',                                        'Payroll Related'),
  ('Modulr',                                         'Payroll Related'),
  -- Advisory
  ('Management Accounts',                            'Advisory'),
  ('Review Meetings',                                'Advisory'),
  ('Fractional CFO',                                 'Advisory'),
  ('Bespoke Analysis',                               'Advisory'),
  ('Business Plans',                                 'Advisory'),
  ('Billable Hours',                                 'Advisory'),
  -- Company Secretarial
  ('Confirmation Statement',                         'Company Secretarial'),
  ('Company Formation',                              'Company Secretarial'),
  ('HMRC Registrations',                             'Company Secretarial'),
  ('Companies House Amendments',                     'Company Secretarial'),
  ('ID Verification',                                'Company Secretarial'),
  ('Registered Office',                              'Company Secretarial'),
  -- All Inclusive (recurring bundles — fee engine only, never on a one-off bill)
  ('Accountancy Services Retainer',                  'All Inclusive'),
  ('All Inclusive Fees - Ltd Companies (VAT Registered)',     'All Inclusive'),
  ('All Inclusive Fees - Ltd Companies (Not VAT Registered)', 'All Inclusive'),
  ('All Inclusive Fees - Sole Traders',              'All Inclusive'),
  ('All Inclusive Fees - LLPs',                      'All Inclusive'),
  ('All Inclusive Fees - Partnerships',              'All Inclusive'),
  -- Other
  ('Software',                                       'Other'),
  ('Fee Protection Insurance',                       'Other'),
  ('SA302s',                                         'Other'),
  ('Accountant Certificates',                        'Other'),
  ('Lending Commissions',                            'Other')
) as m(item_name, category)
where s.qbo_item_name = m.item_name;
