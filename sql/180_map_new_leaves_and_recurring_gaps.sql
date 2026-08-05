-- 180: Make every QBO leaf reachable from Athena, and close the simple
-- recurring-service gaps.
--
-- Two problems, sized from live_billing (active rows, 2026-08-05):
--
--  * 15 entries / ~14 clients / £12,232 a year are recurring services with no
--    Athena service_id at all — Fee Protection Insurance, ID Verification,
--    Companies House Amendments, Dormant Accounts, the Retainer. Nothing
--    conceptually hard; they were simply never modelled. Fixed here.
--
--  * 26 entries / 26 clients / £81,146 a year are All Inclusive packages.
--    That is a genuine modelling problem, not a missing row: QBO bills the
--    package as ONE line while a quote is built from components, so no mapping
--    can reconcile 1 live line against 5 quote lines. Mapping them here does
--    not fix that — but it turns a silent unresolved blank in the comparison
--    into an explicit "live has a package the quote doesn't", which is the
--    honest state until the bundle question is decided.
--
-- Also maps the 14 leaves created by the rebuild so they can actually be
-- billed. Each gets a fee-engine service_id (quotable, and visible to the
-- quote-vs-live comparison) and, where a one-off bill is plausible, an ad-hoc
-- label for the /billing dropdown. Payroll already worked this way — a
-- snake_case service plus a display label pointing at the same item.
--
-- Not given labels: the All Inclusive packages and the Retainer. They are
-- recurring bundles; offering them as one-off bill lines would invite exactly
-- the kind of mis-billing this whole exercise was about.

-- ── fee-engine services (is_adhoc = false; feed the comparison) ──────
insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, label, is_adhoc)
values
  -- recurring services that existed but were never modelled
  ('fee_protection',            '19', 'Fee Protection Insurance',                 'Fee Protection Insurance',      false),
  ('id_verification',           '39', 'ID Verification',                          'ID Verification',               false),
  ('companies_house_amendments','37', 'Companies House Amendments',               'Companies House Amendments',    false),
  ('dormant_accounts',          '25', 'Statutory Accounts - Dormant Ltd Company', 'Dormant Accounts',              false),
  ('retainer',                  '11', 'Accountancy Services Retainer',            'Accountancy Services Retainer', false),
  -- the All Inclusive bundles: mapped so the mismatch is legible, not silent
  ('all_inclusive_ltd_vat',     '3',  'All Inclusive Fees - Ltd Companies (VAT Registered)',     'All Inclusive — Ltd (VAT reg)',     false),
  ('all_inclusive_ltd_novat',   '16', 'All Inclusive Fees - Ltd Companies (Not VAT Registered)', 'All Inclusive — Ltd (not VAT reg)', false),
  ('all_inclusive_sole_trader', '17', 'All Inclusive Fees - Sole Traders',                       'All Inclusive — Sole Trader',       false),
  ('all_inclusive_llp',         '56', 'All Inclusive Fees - LLPs',                               'All Inclusive — LLP',               false),
  ('all_inclusive_partnership', '57', 'All Inclusive Fees - Partnerships',                       'All Inclusive — Partnership',       false),
  -- leaves created by the rebuild
  ('bookkeeping_novat',         '58', 'Bookkeeping (non-VAT registered)',   'Bookkeeping (non-VAT)',          false),
  ('ltd_accounts',              '59', 'Statutory Accounts - Ltd Company',   'Statutory Accounts — Ltd',       false),
  ('llp_accounts',              '60', 'Statutory Accounts - LLP',           'Statutory Accounts — LLP',       false),
  ('partnership_accounts',      '61', 'Statutory Accounts - Partnership',   'Statutory Accounts — Partnership', false),
  ('property_accounts',         '62', 'Statutory Accounts - Property',      'Statutory Accounts — Property',  false),
  ('ct600',                     '63', 'Tax Returns - Ltd Company (CT600)',  'CT600',                          false),
  ('llp_tax_return',            '64', 'Tax Returns - LLP',                  'Tax Returns — LLP',              false),
  ('partnership_tax_return',    '65', 'Tax Returns - Partnership (SA800)',  'Tax Returns — Partnership',      false),
  ('bespoke_analysis',          '66', 'Bespoke Analysis',                   'Bespoke Analysis',               false),
  ('business_plans',            '67', 'Business Plans',                     'Business Plans',                 false),
  ('billable_hours',            '27', 'Billable Hours',                     'Billable Hours',                 false)
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      label = excluded.label;

-- ── ad-hoc labels (is_adhoc = true; the /billing dropdown) ──────────
insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, is_adhoc)
values
  ('Statutory Accounts - Dormant Ltd Company', '25', 'Statutory Accounts - Dormant Ltd Company', true),
  ('Statutory Accounts - LLP',                 '60', 'Statutory Accounts - LLP',                 true),
  ('Statutory Accounts - Partnership',         '61', 'Statutory Accounts - Partnership',         true),
  ('Statutory Accounts - Property',            '62', 'Statutory Accounts - Property',            true),
  ('Tax Returns - LLP',                        '64', 'Tax Returns - LLP',                        true),
  ('Tax Returns - Partnership (SA800)',        '65', 'Tax Returns - Partnership (SA800)',        true),
  ('Bookkeeping (non-VAT registered)',         '58', 'Bookkeeping (non-VAT registered)',         true),
  ('Bespoke Analysis',                         '66', 'Bespoke Analysis',                         true),
  ('Business Plans',                           '67', 'Business Plans',                           true),
  ('Billable Hours',                           '27', 'Billable Hours',                           true),
  ('Companies House Amendments',               '37', 'Companies House Amendments',               true),
  ('ID Verification',                          '39', 'ID Verification',                          true),
  ('Fee Protection Insurance',                 '19', 'Fee Protection Insurance',                 true),
  ('Company Formation',                        '28', 'Company Formation',                        true),
  ('Confirmation Statement',                   '21', 'Confirmation Statement',                   true),
  ('HMRC Registrations',                       '38', 'HMRC Registrations',                       true),
  ('Fractional CFO',                           '4',  'Fractional CFO',                           true),
  ('Review Meetings',                          '36', 'Review Meetings',                          true)
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      is_adhoc = true;
