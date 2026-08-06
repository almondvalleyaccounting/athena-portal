-- 185: Internal comments on one-off bills (the standalone Billing module).
--
-- The ask (Bobby, 2026-08-06): when the team raises a bill I often can't tell
-- from the service line and amount alone what it's actually for. Let them type
-- comments telling me more — and those comments stay inside Athena. They are
-- never part of the QuickBooks push and never reach the client.
--
-- Nothing here is read by supabase/functions/qbo-push-billing-items: the push
-- only ever reads billing_items.lines (service/description/qty/rate) plus the
-- billing contact, so a comment has no route out. Keeping them in their own
-- table rather than a column on billing_items makes that structural — a future
-- `select *` on the bill row can't pick them up by accident.
--
-- Visibility mirrors the parent bill exactly. The select policy leans on
-- billing_items' own RLS through the EXISTS: row security applies to tables
-- referenced inside a policy, so whoever can see the bill can see its
-- comments — including the can_view_pushed_invoices() gate on pushed rows —
-- and there's no second copy of that rule to drift out of step.

create table if not exists public.billing_item_comments (
  id              uuid primary key default gen_random_uuid(),
  billing_item_id uuid not null references public.billing_items(id) on delete cascade,
  author_id       uuid references public.staff_profiles(id) on delete set null,
  body            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists billing_item_comments_item_idx
  on public.billing_item_comments (billing_item_id, created_at);

create or replace function public.billing_item_comments_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists billing_item_comments_touch on public.billing_item_comments;
create trigger billing_item_comments_touch
  before update on public.billing_item_comments
  for each row execute function public.billing_item_comments_touch();

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.billing_item_comments enable row level security;

-- Read/write follows the bill: if billing_items' own policies let you see the
-- row, you can read its comments and add one.
drop policy if exists billing_item_comments_select on public.billing_item_comments;
create policy billing_item_comments_select on public.billing_item_comments
  for select using (
    exists (select 1 from public.billing_items b where b.id = billing_item_id)
  );

drop policy if exists billing_item_comments_insert on public.billing_item_comments;
create policy billing_item_comments_insert on public.billing_item_comments
  for insert with check (
    author_id = auth.uid()
    and exists (select 1 from public.billing_items b where b.id = billing_item_id)
  );

-- Only the person who wrote it can change or remove it — a comment is a record
-- of what someone said, so nobody edits it on their behalf.
drop policy if exists billing_item_comments_update on public.billing_item_comments;
create policy billing_item_comments_update on public.billing_item_comments
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists billing_item_comments_delete on public.billing_item_comments;
create policy billing_item_comments_delete on public.billing_item_comments
  for delete using (author_id = auth.uid());

comment on table public.billing_item_comments is
  'Internal-only commentary on a one-off bill: why it was raised, what it '
  'covers, anything the approver needs. Athena-only — never pushed to '
  'QuickBooks and never shown to the client. Visibility follows billing_items.';
