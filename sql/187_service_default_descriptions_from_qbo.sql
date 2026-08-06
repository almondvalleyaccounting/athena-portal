-- 187: seed each product's default invoice-line description from QBO.
--
-- The ask (Bobby, 2026-08-06): when the team picks a product on a bill, pull the
-- default description through from the related QuickBooks product where that
-- product has one. The pulling-through happens in the bill editor
-- (BillingPage.jsx reads qbo_service_items.default_description and fills an
-- empty Description with it); this file is the other half — getting QBO's own
-- item descriptions into that column.
--
-- Values are QBO's Item "Memo/Description" as at 2026-08-06, matched on
-- qbo_item_name, so every row mapped to the same QBO product gets the same
-- default (the ad-hoc label and the fee-engine slug both point at one item).
--
-- QBO stays the source of truth: if a description is edited in QBO, re-run this
-- with the new text. Only products that actually have a description in QBO
-- appear here — the rest keep whatever Athena had, or stay empty, and an empty
-- default just means the team types the line themselves.
--
-- Two deliberate departures from QBO's text:
--   * 'Tax Returns - MTD' reads "Quarterly Retun for MTD" in QBO. Seeded here
--     spelled correctly; QBO's own item still carries the typo and wants fixing
--     there too, or the next re-run will drag it back in.
--   * The All Inclusive bundles are skipped. Their QBO descriptions itemise
--     "Annual Statutory Accounts", which is the term sql/186 just retired, so
--     importing them would put the old wording back on invoices. They need
--     rewording in QBO first — and they're recurring bundles, not something a
--     one-off bill is raised against.

update public.qbo_service_items q
set default_description = d.descr, updated_at = now()
from (values
  ('Business Accounts and Corporation Tax Combined',
     E'One set of detailed accounts for members and HMRC\n\nOne set of abbreviated accounts for Companies House\n\nBusiness tax return for HMRC'),
  ('Business Accounts - Dormant Ltd Company',
     'Preparation and submission of dormant company accounts to Companies House'),
  ('Business Accounts - Sole Trader',      'Sole Trader Accounts'),
  ('Tax Returns - Individual',             'Self Assessment Tax Return'),
  ('Tax Returns - MTD',                    'Quarterly Return for MTD'),
  ('Bookkeeping (VAT Registered)',         'Monthly Bookkeeping & VAT Returns'),
  ('Payroll',                              'Payroll'),
  ('Modulr',                               'Modulr - Wages and HMRC payments'),
  ('Management Accounts',                  'Monthly Management Accounts'),
  ('Review Meetings',                      'Annual Review Meeting'),
  ('Billable Hours',                       'Billable Hours'),
  ('Fractional CFO',                       'Finance Director Services'),
  ('Confirmation Statement',               'Submission of Annual Confirmation Statement, including Companies House Fees'),
  ('Company Formation',                    'Registration of a Limited Company with Companies House.'),
  ('ID Verification',                      'Verification of ID to obtain Companies House Personal Code'),
  ('Registered Office',                    'Use of our office as the company registered office address'),
  ('Fee Protection Insurance',             'Fee Protection Insurance'),
  ('Software',                             'Bookkeeping Software'),
  ('Accountancy Services Retainer',        'Monthly retainer for accountancy services')
) as d(item_name, descr)
where q.qbo_item_name = d.item_name
  and coalesce(q.default_description, '') <> d.descr;
