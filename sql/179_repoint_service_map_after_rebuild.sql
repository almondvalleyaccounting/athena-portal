-- 179: Re-point the service map at the rebuilt QBO catalogue.
--
-- The rebuild renamed 14 items and added 14 leaves, so stored qbo_item_names
-- are stale and two ad-hoc labels now point at the wrong thing.
--
-- Also stops relying on name matching. The push resolves a line's service by
-- service_id OR qbo_item_name, and 'Software Licences' worked only because an
-- item happened to carry that name — the rebuild renamed it to 'Software' and
-- silently broke the match. Every ad-hoc label now gets an explicit row.

-- 1. Refresh the denormalised names from the mirror.
update public.qbo_service_items s
   set qbo_item_name = i.name
  from public.qbo_items i
 where i.qbo_item_id = s.qbo_item_id
   and i.name <> s.qbo_item_name;

-- 2. Re-point the two labels whose meaning changed. Item 13 used to be
--    "Annual Statutory Accounts & Business Tax" and covered both; it is now
--    "Accounts & Corporation Tax", a service in its own right, so accounts-only
--    and CT-only work belong on the new dedicated leaves.
update public.qbo_service_items
   set qbo_item_id = '59', qbo_item_name = 'Statutory Accounts - Ltd Company'
 where service_id = 'Accounts Production';

update public.qbo_service_items
   set qbo_item_id = '63', qbo_item_name = 'Tax Returns - Ltd Company (CT600)'
 where service_id = 'Corporation Tax';

-- 3. Explicit rows for the ad-hoc labels that were resolving by name, plus the
--    two that become billable for the first time.
insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, is_adhoc, default_description)
values
  ('Payroll',                 '15', 'Payroll',                    true, null),
  ('Management Accounts',     '24', 'Management Accounts',        true, null),
  ('Registered Office',       '35', 'Registered Office',          true, 'Use of our office as the registered office address'),
  ('Software',                '20', 'Software',                   true, null),
  ('SA302s',                  '68', 'SA302s',                     true, null),
  ('Accountant Certificates', '69', 'Accountant Certificates',    true, null)
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      is_adhoc = true;

-- 'Software Licences' is superseded by 'Software' above.
delete from public.qbo_service_items where service_id = 'Software Licences';

-- 4. Two fee-engine services that have never been mapped, and now have an
--    obvious home in the rebuilt catalogue.
insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, label, is_adhoc)
values
  ('sole_trader_accounts', '33', 'Statutory Accounts - Sole Trader', 'Sole Trader Accounts', false),
  ('mtd_returns',          '46', 'Tax Returns - MTD',               'MTD Returns',          false),
  ('fractional_cfo',        '4', 'Fractional CFO',                  'Fractional CFO',       false)
on conflict (service_id) do nothing;

-- 5. 'Advisory' and 'Company Secretarial' are category names in the new
--    hierarchy, not services. Billing against a category is what put revenue
--    on a catch-all in the first place, so they go the way of 'Admin'
--    (sql/178) — dropped from the label list in billingServices.js. Neither
--    has a row here to delete; this note records why they are absent.
