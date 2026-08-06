-- 186: "Statutory Accounts" becomes "Business Accounts" across the products.
--
-- The ask (Bobby, 2026-08-06): rename the billing product 'Accounts Production'
-- to 'Business Accounts - Ltd Companies' — it is NOT retired, it's the product
-- the Ltd accounts work has been billed to all along (it maps to QBO item #59,
-- 'Statutory Accounts - Ltd Company'). Change the term 'Statutory Accounts' to
-- 'Business Accounts' on every product carrying it, and rename
-- 'Accounts & Corporation Tax' to 'Business Accounts and Corporation Tax
-- Combined'.
--
-- QBO was renamed first, by the qbo-catalog-rename edge function (7 items:
-- 59, 25, 60, 61, 62, 33, 13 — all applied 2026-08-06). qbo_item_name here is a
-- mirror of QBO's own name, so it is updated to match; the qbo_item_id values
-- are untouched, and that is what the push actually resolves against, so no
-- mapping breaks.
--
-- Not touched, deliberately:
--   * The WORK vocabulary. 'Accounts Production' is also a work/job service on
--     bm_task_schedule, scheduled_tasks, timesheets and the planner's duration
--     defaults. That is how BrightManager names the job, not a product, and
--     renaming it would break BM import matching.
--   * Fee-engine service ids (ltd_accounts, accounts_ct, …). They are slugs,
--     not display text — quotes, standard_fees, entity_fees and live_billing
--     all key off them. Only their `label` changes.
--   * billing_service_mappings 'Annual Statutory Accounts & Business Tax'. That
--     row maps the line text on existing QBO recurring templates; renaming it
--     would stop the pull recognising them.
--   * Bills already pushed to QBO. Their line text is what the client was
--     actually invoiced, so history keeps the wording it was issued with.
--
-- The rename map is repeated as an inline VALUES list per statement rather than
-- held in a temp table, so the file is safe to run statement-by-statement.

-- ── 1. The mirror of QBO's item names ───────────────────────────────────────

update public.qbo_service_items q
set qbo_item_name = r.new, updated_at = now()
from (values
  ('Statutory Accounts - Ltd Company',         'Business Accounts - Ltd Companies'),
  ('Statutory Accounts - Dormant Ltd Company', 'Business Accounts - Dormant Ltd Company'),
  ('Statutory Accounts - LLP',                 'Business Accounts - LLP'),
  ('Statutory Accounts - Partnership',         'Business Accounts - Partnership'),
  ('Statutory Accounts - Property',            'Business Accounts - Property'),
  ('Statutory Accounts - Sole Trader',         'Business Accounts - Sole Trader'),
  ('Accounts & Corporation Tax',               'Business Accounts and Corporation Tax Combined')
) as r(old, new)
where q.qbo_item_name = r.old;

-- ── 2. The ad-hoc bill labels (service_id IS the label the team picks) ───────
-- No foreign key references qbo_service_items, so these are safe to rename in
-- place. Skipped if the target label already exists, so a re-run can't collide.

update public.qbo_service_items q
set service_id = r.new, updated_at = now()
from (values
  -- Bobby's wording, hence the plural — it also matches the All Inclusive
  -- items, which are already "- Ltd Companies".
  ('Accounts Production',                      'Business Accounts - Ltd Companies'),
  ('Statutory Accounts - Dormant Ltd Company', 'Business Accounts - Dormant Ltd Company'),
  ('Statutory Accounts - LLP',                 'Business Accounts - LLP'),
  ('Statutory Accounts - Partnership',         'Business Accounts - Partnership'),
  ('Statutory Accounts - Property',            'Business Accounts - Property'),
  ('Statutory Accounts - Sole Trader',         'Business Accounts - Sole Trader'),
  ('Accounts & Corporation Tax',               'Business Accounts and Corporation Tax Combined')
) as r(old, new)
where q.service_id = r.old
  and q.is_adhoc
  and not exists (select 1 from public.qbo_service_items x where x.service_id = r.new);

-- ── 3. Fee-engine display labels ────────────────────────────────────────────
-- The ids stay as they are; only what's shown changes.

update public.qbo_service_items
set label = replace(label, 'Statutory Accounts', 'Business Accounts'), updated_at = now()
where label like 'Statutory Accounts%';

-- ── 4. Default invoice-line descriptions that carried the old term ───────────

update public.qbo_service_items
set default_description = 'Annual Business Accounts & Corporation Tax Return', updated_at = now()
where service_id = 'accounts_ct'
  and default_description = 'Annual Statutory Accounts & Business Tax Return';

update public.qbo_service_items
set default_description = 'Business accounts', updated_at = now()
where service_id = 'Business Accounts - Ltd Companies'
  and default_description = 'Accounts production';

-- ── 5. Bills still in the pipeline ──────────────────────────────────────────
-- Draft/approved/not-required only — a pushed bill keeps the wording that was
-- actually invoiced. The one-line summary in `service` is only rewritten when
-- it IS the product name; a multi-line summary ("Bookkeeping +1 more") stays
-- accurate on its own. 'Accounts:…' is the fully qualified QBO name, which is
-- what "copy from past invoice" stores.

update public.billing_items b
set service = r.new
from (values
  ('Accounts Production',                       'Business Accounts - Ltd Companies'),
  ('Statutory Accounts - Dormant Ltd Company',  'Business Accounts - Dormant Ltd Company'),
  ('Statutory Accounts - LLP',                  'Business Accounts - LLP'),
  ('Statutory Accounts - Partnership',          'Business Accounts - Partnership'),
  ('Statutory Accounts - Property',             'Business Accounts - Property'),
  ('Statutory Accounts - Sole Trader',          'Business Accounts - Sole Trader'),
  ('Accounts:Statutory Accounts - Sole Trader', 'Business Accounts - Sole Trader'),
  ('Accounts & Corporation Tax',                'Business Accounts and Corporation Tax Combined')
) as r(old, new)
where b.service = r.old
  and b.status <> 'pushed';

update public.billing_items b
set lines = (
  select jsonb_agg(
           case when r2.new is null then l else jsonb_set(l, '{service}', to_jsonb(r2.new)) end
           order by ord
         )
  from jsonb_array_elements(b.lines) with ordinality as t(l, ord)
  left join (values
    ('Accounts Production',                       'Business Accounts - Ltd Companies'),
    ('Statutory Accounts - Dormant Ltd Company',  'Business Accounts - Dormant Ltd Company'),
    ('Statutory Accounts - LLP',                  'Business Accounts - LLP'),
    ('Statutory Accounts - Partnership',          'Business Accounts - Partnership'),
    ('Statutory Accounts - Property',             'Business Accounts - Property'),
    ('Statutory Accounts - Sole Trader',          'Business Accounts - Sole Trader'),
    ('Accounts:Statutory Accounts - Sole Trader', 'Business Accounts - Sole Trader'),
    ('Accounts & Corporation Tax',                'Business Accounts and Corporation Tax Combined')
  ) as r2(old, new) on r2.old = l->>'service'
)
where b.status <> 'pushed'
  and jsonb_typeof(b.lines) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(b.lines) l
    join (values
      ('Accounts Production'),
      ('Statutory Accounts - Dormant Ltd Company'),
      ('Statutory Accounts - LLP'),
      ('Statutory Accounts - Partnership'),
      ('Statutory Accounts - Property'),
      ('Statutory Accounts - Sole Trader'),
      ('Accounts:Statutory Accounts - Sole Trader'),
      ('Accounts & Corporation Tax')
    ) as r3(old) on r3.old = l->>'service'
  );
