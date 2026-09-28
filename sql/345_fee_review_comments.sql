-- 345: Internal comments on a client's fee review.
--
-- Companion to quote_comments (sql/344). A fee review isn't a quote: on the
-- Quotes list it is one row per client, at the client's latest fee-change
-- state (useFeeReviews — staged live_billing lines or a fee_proposals row).
-- So the thread hangs off the client, not off any one proposal, and follows
-- the client from one review to the next.
--
-- Visibility is the same as fee_proposals: fee staff only
-- (can_view_client_fees), restricted by the per-client figure scoping of
-- sql/329. Portal users are not staff and see nothing.
--
-- Writes go through the quote-comments edge function; the browser holds
-- SELECT and nothing else.

create table if not exists public.fee_review_comments (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  author_id   uuid references public.staff_profiles(id) on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);

create index if not exists fee_review_comments_entity_idx
  on public.fee_review_comments (entity_id, created_at);

alter table public.fee_review_comments enable row level security;

drop policy if exists fee_review_comments_read on public.fee_review_comments;
create policy fee_review_comments_read on public.fee_review_comments
  for select to authenticated using ((select can_view_client_fees()));

drop policy if exists "client figures scoped" on public.fee_review_comments;
create policy "client figures scoped" on public.fee_review_comments
  as restrictive for all to authenticated using (
    (select has_all_figures())
    or entity_id in (select my_figure_entities('{clients,fee-engine,billing}'::text[]))
  );

revoke all on public.fee_review_comments from public, anon, authenticated;
grant select on public.fee_review_comments to authenticated;
grant all on public.fee_review_comments to service_role;

comment on table public.fee_review_comments is
  'Internal-only notes on a client''s fee review, one thread per client. '
  'Fee staff only, figure-scoped like fee_proposals; writes via the '
  'quote-comments edge function only.';
