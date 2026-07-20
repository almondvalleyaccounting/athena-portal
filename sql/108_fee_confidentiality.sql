-- 108: Fee confidentiality — enforce can_view_client_fees at the data layer.
--
-- The flag existed (Staff & Permissions "Client fees" column; true for Bobby,
-- Tracy, Yvonne) and already gated client_service_allocations + entity_fees,
-- but the core fee tables were readable by ANY active staff. Tiering agreed
-- 20/07/2026:
--   * can_view_client_fees  → the full fee book: live_billing, quotes,
--     quote_line_items (plus allocations/entity_fees as before).
--   * can_view_billing      → the ad-hoc billing workqueue they operate
--     (billing_items), amounts included.
--   * neither               → no fee data anywhere.
--
-- Onboarding still needs quote/billing SERVICE data (ids/names, no amounts)
-- for step resolution regardless of fee visibility — provided via two
-- names-only SECURITY DEFINER RPCs consumed by src/modules/onboarding/api.js.

create or replace function public.can_view_client_fees()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and is_active = true and can_view_client_fees = true
  );
$$;

-- ── SELECT policies ──
drop policy if exists "Staff can view billing" on live_billing;
create policy "Fee staff can view live billing" on live_billing
  for select using (can_view_client_fees());

drop policy if exists "Staff can view quotes" on quotes;
create policy "Quote staff can view quotes" on quotes
  for select using (
    can_view_client_fees()
    or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_quotes = true
    )
  );

drop policy if exists "Staff can view line items" on quote_line_items;
create policy "Quote staff can view line items" on quote_line_items
  for select using (
    can_view_client_fees()
    or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_quotes = true
    )
  );

drop policy if exists "Staff can view billing" on billing_items;
create policy "Billing staff can view billing items" on billing_items
  for select using (
    can_view_client_fees()
    or exists (
      select 1 from staff_profiles
      where id = auth.uid() and is_active = true and can_view_billing = true
    )
  );

-- ── Names-only RPCs for onboarding step resolution ──
-- Everything onboarding consumes, nothing more: no monetary columns.
create or replace function public.onboarding_quote_for_entity(p_entity_id uuid)
returns table(id uuid, quote_ref text, status text, created_at timestamptz, dd_mandate_status text, service_ids text[])
language sql stable security definer
set search_path to 'public'
as $$
  select q.id, q.quote_ref, q.status, q.created_at, q.dd_mandate_status,
         coalesce(array_agg(li.service_id) filter (where li.service_id is not null), '{}')
  from quotes q
  left join quote_line_items li on li.quote_id = q.id
  where q.entity_id = p_entity_id
    and q.status <> 'deleted'
    and is_active_staff()
  group by q.id, q.quote_ref, q.status, q.created_at, q.dd_mandate_status;
$$;

create or replace function public.onboarding_billing_names_for_entity(p_entity_id uuid)
returns table(row_id uuid, service_names text[])
language sql stable security definer
set search_path to 'public'
as $$
  select lb.id,
         coalesce(array(
           select s->>'service_id'
           from jsonb_array_elements(coalesce(lb.services, '[]'::jsonb)) s
           where coalesce(s->>'service_id', '') <> ''
         ), '{}')
  from live_billing lb
  where lb.entity_id = p_entity_id
    and lb.status = 'active'
    and is_active_staff();
$$;
