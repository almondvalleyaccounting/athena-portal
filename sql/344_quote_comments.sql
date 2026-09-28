-- 344: Internal comments on quotes.
--
-- The ask (2026-09-28): a running set of notes on each quote, so the team can
-- record what was discussed, why a fee is what it is, what the client said.
-- Staff-only, never on the quote PDF, the email or the accept page — none of
-- those read this table, and keeping comments out of `quotes` itself means a
-- future `select *` on the quote row can't carry them anywhere.
--
-- Visibility follows the parent quote exactly: the select policy leans on
-- quotes' own RLS through the EXISTS (row security applies to tables referenced
-- inside a policy), so whoever can see the quote — fee staff, quote staff, and
-- the per-client figure scoping of sql/329 — can see its comments, with no
-- second copy of the rule to drift.
--
-- Writes go through the quote-comments edge function (CLAUDE.md: a new
-- mutating path is an edge function). The browser holds SELECT and nothing
-- else; attribution comes from the caller's JWT, never from the request body.

create table if not exists public.quote_comments (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  author_id   uuid references public.staff_profiles(id) on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);

create index if not exists quote_comments_quote_idx
  on public.quote_comments (quote_id, created_at);

alter table public.quote_comments enable row level security;

drop policy if exists quote_comments_select on public.quote_comments;
create policy quote_comments_select on public.quote_comments
  for select to authenticated using (
    (select is_active_staff())
    and exists (select 1 from public.quotes q where q.id = quote_id)
  );

-- The schema's default privileges hand a new table to anon and authenticated
-- in full; take that back and leave the browser read-only.
revoke all on public.quote_comments from public, anon, authenticated;
grant select on public.quote_comments to authenticated;
grant all on public.quote_comments to service_role;

comment on table public.quote_comments is
  'Internal-only notes on a quote. Never on the PDF, email or accept page. '
  'Visibility follows quotes (RLS through EXISTS); writes via the '
  'quote-comments edge function only.';
