-- 281_hmrc_unallocated_credit.sql
--
-- The CIS credit pot, as HMRC states it.
--
-- Until now Athena could see a CIS credit only once it had been CONSUMED. The
-- EPS lines on a monthly PAYE bill equal the credit allocated to that bill --
-- for LJM Gas Glasgow, GBP 14,574.73 in 2025-26 and GBP 1,845.46 in 2026-27,
-- exact on both -- so the pot itself never appeared anywhere.
--
-- The credits-history page is not a substitute. Its `Not allocated` keeps that
-- label after the money has gone: LJM's 2024-25 still reads GBP 19,173.29 not
-- allocated, which is precisely the sum that left for Corporation Tax on
-- 18 Dec 2025, ten months earlier. Summing it overstates the pot, and an early
-- version of the scraper's own report did exactly that to GBP 840,861.59
-- practice-wide.
--
-- HMRC does state it, on the overdue-payments page, under "Unallocated payments
-- and credits" -- prose and bullets rather than a table, which is why a
-- table-driven parser walked past it. It is current, and it is typed by credit:
--
--   You have GBP 5,032.32 of unallocated credits:
--     GBP 5,032.32 unallocated credit - CIS deduction reclaimed
--
-- Amounts in PENCE, as everywhere else in this schema. The public view converts
-- to pounds; nothing downstream divides by 100.

create table if not exists hmrc.unallocated_credit (
  id          bigserial primary key,
  run_id      bigint  not null references hmrc.run(id) on delete cascade,
  client_id   bigint  not null references hmrc.client(id) on delete cascade,
  -- 'credit' or 'payment'. HMRC's heading covers both and the distinction
  -- matters: a CIS credit arose from an EPS, an unallocated payment is cash the
  -- client sent that HMRC has not matched to a bill.
  kind        text    not null,
  credit_type text    not null,
  amount      bigint  not null,
  -- HMRC prints its own total above the bullets. Stored beside the rows rather
  -- than instead of them, so a pot that quietly loses a line is visible.
  stated_total bigint,
  detail_ties  boolean
);

comment on table hmrc.unallocated_credit is
  'Unallocated payments and credits from HMRC''s PAYE overdue-payments page: the only place the CIS credit pot is stated rather than inferred. Amounts in pence. Appended per run like every other child table - scope to the latest run_id.';

create index if not exists unallocated_credit_client_run
  on hmrc.unallocated_credit (client_id, run_id);

-- The scraper APPENDS a row set per run and never replaces, so every reader
-- must scope to the latest run or the pot doubles with each scrape. That has
-- bitten this schema before (sql/198).
create or replace view public.v_hmrc_unallocated_credit
with (security_invoker = false) as
  select c.entity_id,
         c.name        as hmrc_name,
         c.paye_ref,
         u.kind,
         u.credit_type,
         round(u.amount::numeric / 100.0, 2)       as amount,
         round(u.stated_total::numeric / 100.0, 2) as stated_total,
         u.detail_ties,
         u.run_id
    from hmrc.unallocated_credit u
    join hmrc.client c on c.id = u.client_id
   where u.run_id = (select max(u2.run_id)
                       from hmrc.unallocated_credit u2
                      where u2.client_id = u.client_id)
     and public.hmrc_can_read();

comment on view public.v_hmrc_unallocated_credit is
  'Latest stated unallocated credit per client, in pounds. hmrc_can_read() IS the access control here - the view runs as owner, and portal clients hold authenticated alongside staff.';

-- A definer view over a private schema must carry its own predicate and must
-- never be reachable by anon. The anon key ships in the frontend bundle.
--
-- `authenticated` is revoked too, not just anon. A default privilege on the
-- public schema grants anon AND authenticated arwdDxtm on everything created
-- here, so a bare `grant select` leaves the write bits from creation sitting
-- there. They cannot be exercised through this particular view -- it joins and
-- calls a function, so it is not auto-updatable -- but relying on that is
-- relying on an accident of the view's shape rather than on a grant.
revoke all on public.v_hmrc_unallocated_credit from public, anon, authenticated;
grant select on public.v_hmrc_unallocated_credit to authenticated, service_role;

-- The scraper writes as hmrc_scraper, not service_role. A default privilege on
-- this schema already grants it arw on tables postgres creates, so this is
-- belt and braces -- but the default only fires when postgres is the creator,
-- and a table created any other way would silently be unwritable.
grant select, insert on hmrc.unallocated_credit to hmrc_scraper;
grant usage, select on sequence hmrc.unallocated_credit_id_seq to hmrc_scraper;
