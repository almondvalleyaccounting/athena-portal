-- 327: the proposal pack's pages (Pricing & Proposals → Proposal pack).
--
-- A proposal pack is a PDF built from one page per service the client is
-- quoted for, plus a cover and a next-steps page. The standard text for each
-- page lives in the app (src/modules/proposals/packContent.js); this table
-- holds only the pages someone has edited in the design area, keyed by page.
-- Resetting a page deletes its row, so it goes back to the standard text.
--
-- Staff read it (the pack is built in the browser). Nobody writes it from the
-- browser: saves go through the proposal-pack edge function, which checks
-- can_edit_fee_schedule and records who saved.

create table if not exists public.proposal_pack_pages (
  page_key   text primary key check (page_key ~ '^[a-z0-9_]{1,60}$'),
  content    jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles(id)
);

alter table public.proposal_pack_pages enable row level security;

drop policy if exists "Staff can read proposal pack pages" on public.proposal_pack_pages;
create policy "Staff can read proposal pack pages" on public.proposal_pack_pages
  for select to authenticated using (public.is_active_staff());

revoke all on public.proposal_pack_pages from public, anon, authenticated;
grant select on public.proposal_pack_pages to authenticated;
grant all on public.proposal_pack_pages to service_role;
