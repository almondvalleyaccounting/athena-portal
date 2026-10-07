-- 353 — Approving and pushing invoices is for billing approvers only.
--
-- Staff & Permissions has always had the setting: Billing → Submitter / Approver,
-- which derives staff_profiles.can_approve_billing (sql/329). Nothing enforced it.
-- billing_items' update policy lets anyone with billing write status = 'approved',
-- and the push edge functions checked only "is staff", so a submitter could approve
-- and push. The edge functions now check the flag on a live push; this is the table
-- half, so approval cannot be written around the UI either.
--
-- Machine callers pass: service_role (the push functions stamp 'pushed') and no-JWT
-- sessions (pg_cron, psql), same as is_staff_or_service().
--
-- One carve-out: the fixed £20 + VAT Companies House ID-check invoice, which the CH
-- codes flow raises approved and pushes in one step for whoever records "we verify".
-- It is recognised by its exact shape, so the most a submitter can do with it is
-- that one £24 invoice. qbo-push-billing-items carries the same carve-out.

create or replace function public.billing_approver_or_machine()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.jwt.claims', true), '') is null
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or exists (select 1 from staff_profiles
                  where id = auth.uid() and is_active and can_approve_billing);
$$;

-- Called only from the definer triggers below, which run as the owner.
revoke all on function public.billing_approver_or_machine() from public, anon, authenticated;
grant execute on function public.billing_approver_or_machine() to service_role;

create or replace function public.billing_item_is_ch_id_check(b public.billing_items)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- coalesce: a NULL here would read as "not false" in the trigger and let it through.
  select coalesce(
           b.service = 'CH Personal Code — ID Verification'
       and b.net_amount = 20 and b.vat_amount = 4 and b.gross_amount = 24
       and case when jsonb_typeof(b.lines) = 'array'
                then jsonb_array_length(b.lines) = 1 and (b.lines -> 0 ->> 'net') = '20'
                else false end,
         false);
$$;

revoke all on function public.billing_item_is_ch_id_check(public.billing_items) from public, anon, authenticated;
grant execute on function public.billing_item_is_ch_id_check(public.billing_items) to service_role;

create or replace function public.trg_billing_items_approver_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if billing_approver_or_machine() then return new; end if;

  if tg_op = 'INSERT' then
    if new.status in ('approved', 'pushed') and not billing_item_is_ch_id_check(new) then
      raise exception 'Approving invoices is for billing approvers only (Staff & Permissions → Billing → Approver).'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Moving into approved/pushed, or re-stamping who approved it.
  if (new.status is distinct from old.status and new.status in ('approved', 'pushed'))
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'Approving invoices is for billing approvers only (Staff & Permissions → Billing → Approver).'
      using errcode = '42501';
  end if;

  -- An approved bill is what the approver signed off. A submitter may send it back
  -- to draft, but not change the figures underneath the approval.
  if old.status = 'approved' and new.status = 'approved'
     and (new.net_amount is distinct from old.net_amount
          or new.vat_amount is distinct from old.vat_amount
          or new.gross_amount is distinct from old.gross_amount
          or new.lines is distinct from old.lines
          or new.entity_id is distinct from old.entity_id) then
    raise exception 'This bill is approved. Send it back to draft to change it, then ask an approver.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.trg_billing_items_approver_only() from public, anon, authenticated;

drop trigger if exists trg_billing_items_approver_only on public.billing_items;
create trigger trg_billing_items_approver_only
  before insert or update on public.billing_items
  for each row execute function public.trg_billing_items_approver_only();

-- live_billing: recurring approvals (per-service approval_status in services) and the
-- fee-review go-live approval. Its SELECT is fee-gated already, so in practice only
-- approvers reach these pages, but its UPDATE policy is any active staff.
create or replace function public.trg_live_billing_approver_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if billing_approver_or_machine() then return new; end if;

  if (new.uplift_review_status is distinct from old.uplift_review_status and new.uplift_review_status = 'approved')
     or new.uplift_go_live_approved_by is distinct from old.uplift_go_live_approved_by
     or new.uplift_go_live_approved_at is distinct from old.uplift_go_live_approved_at
     or (select coalesce(jsonb_agg(e -> 'approval_status'), '[]'::jsonb) from jsonb_array_elements(coalesce(new.services, '[]'::jsonb)) e)
        is distinct from
        (select coalesce(jsonb_agg(e -> 'approval_status'), '[]'::jsonb) from jsonb_array_elements(coalesce(old.services, '[]'::jsonb)) e)
  then
    raise exception 'Approving billing is for billing approvers only (Staff & Permissions → Billing → Approver).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.trg_live_billing_approver_only() from public, anon, authenticated;

drop trigger if exists trg_live_billing_approver_only on public.live_billing;
create trigger trg_live_billing_approver_only
  before update on public.live_billing
  for each row execute function public.trg_live_billing_approver_only();
