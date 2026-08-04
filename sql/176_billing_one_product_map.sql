-- 176: One product map, one writer, one reader.
--
-- Before this there were three overlapping surfaces:
--   qbo_service_items      - read by qbo-push-billing-items and the
--                            quote-vs-live comparison. Maintained by SQL only.
--   athena_product_qbo_map - written by /manage/billing/products (sql/121).
--                            NOTHING read it. 0 rows, so nothing to migrate.
--   billing_service_mappings - capacity-planner job types, not products.
--
-- So the mapping page staff would naturally reach for had no effect on
-- where revenue coded, while the table that DID decide it could only be
-- edited by migration. Hence services drifting onto QBO's catch-all
-- (see sql/175).
--
-- qbo_service_items becomes the single source of truth: it has the real
-- readers and the richer columns. /manage/billing/products is repointed
-- at it in the same change, so the page now actually decides where
-- revenue lands. athena_product_qbo_map is dropped.

-- `label` lets the map hold a display name for a service id, so the
-- mapping page can show "Directors' Tax Returns" for directors_tax_return
-- without the frontend keeping a parallel label dictionary.
alter table public.qbo_service_items
  add column if not exists label text;

comment on column public.qbo_service_items.label is
  'Display name for this service in the product mapping UI. Falls back to service_id.';

-- Never read, never written to, superseded by qbo_service_items.
drop table if exists public.athena_product_qbo_map;
