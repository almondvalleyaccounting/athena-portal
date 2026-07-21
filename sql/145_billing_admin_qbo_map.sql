-- 145: Map the ad-hoc "Admin" billing service to a real QBO product.
--
-- Bills raised off an admin task (AdminTaskDetailPage) default the line
-- service to the literal string 'Admin' (billing_items.service). The bill
-- push (qbo-push-billing-items) used to resolve items by NAME and silently
-- auto-create one when none matched — so "Admin" produced a throwaway QBO
-- item under a catch-all income account ("mapping to nothing").
--
-- The push now resolves every line through qbo_service_items first and
-- ERRORS instead of auto-creating. This row points "Admin" at the real
-- "Company Administration" product (QBO item 40). qbo_item_id is text.
insert into public.qbo_service_items (service_id, qbo_item_id, qbo_item_name, default_description)
values ('Admin', '40', 'Company Administration', 'Administration')
on conflict (service_id) do update
  set qbo_item_id = excluded.qbo_item_id,
      qbo_item_name = excluded.qbo_item_name,
      default_description = coalesce(public.qbo_service_items.default_description, excluded.default_description);
