-- 177: Let billing operators write the product map.
--
-- qbo_service_items only ever had a SELECT policy — it was maintained by
-- migration, so nothing needed write access. sql/176 repointed
-- /manage/billing/products at it, which would have made every save fail
-- silently under RLS: the page would look like it worked and change nothing.
--
-- Write gate copied from athena_product_qbo_map (sql/121), the table this
-- one replaced, so the same people keep the same access: billing operators
-- (can_view_billing) plus fee admins (can_view_client_fees, so
-- Bobby/Tracy/Yvonne aren't blocked if they lack the billing flag).
--
-- This is catalog wiring, not fee data — it holds no client amounts — so
-- read stays open to all active staff.

drop policy if exists qbo_service_items_manage on public.qbo_service_items;
create policy qbo_service_items_manage on public.qbo_service_items
  for all to authenticated
  using (
    can_view_client_fees()
    or exists (
      select 1 from public.staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  )
  with check (
    can_view_client_fees()
    or exists (
      select 1 from public.staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  );
