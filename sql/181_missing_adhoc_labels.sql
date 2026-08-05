-- 181: Three billable leaves had no ad-hoc label, so they could be quoted but
-- not billed on a one-off invoice. Omissions from sql/180, not decisions.
--
--   Statutory Accounts - Sole Trader (#33) - the most used of the Statutory
--     Accounts family (21 units / GBP 2,787 this year). Dormant, LLP,
--     Partnership and Property all got labels; this one was simply missed.
--   Accounts & Corporation Tax (#13) - the combined ltd service, and the
--     single biggest product in the catalogue. 'Accounts Production' and
--     'Corporation Tax' cover the two halves separately, so a one-off bill for
--     the combined job had nowhere to go.
--   Tax Returns - MTD (#46) - a quarterly MTD return is a plausible one-off.
--
-- Still deliberately unlabelled: the five All Inclusive packages and the
-- Retainer (recurring bundles - a one-off package bill makes no sense),
-- Modulr (recurring only) and Lending Commissions (income from lenders, not
-- something a client is billed for).

insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, is_adhoc)
values
  ('Statutory Accounts - Sole Trader', '33', 'Statutory Accounts - Sole Trader', true),
  ('Accounts & Corporation Tax',       '13', 'Accounts & Corporation Tax',       true),
  ('Tax Returns - MTD',                '46', 'Tax Returns - MTD',                true)
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      is_adhoc = true;
