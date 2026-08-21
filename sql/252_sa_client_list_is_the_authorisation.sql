-- 252: The SA client list is the authorisation record, so store all of it.
--
-- hmrc.sa_client only ever held the 89 clients the scraper fetched statements
-- for. The cause is in the scraper (C:\Users\bobby\HMRC-Scraper):
-- src/driver/run-sa.js drops every client whose HMRC client-list flag
-- statementAvailable is not "y" — a sensible saving of four requests per
-- account with nothing to show — and then publish-sa.js writes sa_client from
-- the scraped results only. A further 25 were set aside as out of scope into a
-- local file that was never published. hmrc.run recorded clients_seen = 89 with
-- 0 failures, so nothing signalled the loss.
--
-- Being on HMRC's list IS the authorisation; the statement is only the
-- financial detail. So the scraper now publishes every row of the list, and
-- these columns hold what that needs:
--
--   statement_available  HMRC's flag. false means nothing to scrape, NOT that
--                        we are unauthorised — the row still proves the
--                        authorisation.
--   scope_reason         why a listed client is not linked to a live Athena
--                        client: 'no_athena_record', or an entity status such
--                        as 'archived'/'nlac'. null = matched and live.
--
-- Rows with no entity_id are the SA equivalent of hmrc.link_exception: people
-- HMRC says we act for who are not on our client list. The local run file held
-- 22 of them (Mullen R, McLuckie E L, Walsh K J …) and they were invisible.
alter table hmrc.sa_client
  add column if not exists statement_available boolean,
  add column if not exists scope_reason        text;

comment on column hmrc.sa_client.statement_available is 'HMRC''s client-list flag. false = no statement to fetch, which is not evidence about authorisation: presence in this table is the authorisation.';
comment on column hmrc.sa_client.scope_reason is 'Why a listed SA client is not linked to a live Athena client — no_athena_record, or the entity status. null means matched and active.';

-- Backfill the rows already there: all 89 were scraped, so they all had a
-- statement and all matched a live client.
update hmrc.sa_client
   set statement_available = true
 where statement_available is null and entity_id is not null;

-- ── SA authorisations for people who are not our clients ─────────────────
-- The counterpart to v_onboarding_crosscheck_orphans (BrightPay) and
-- hmrc.link_exception (PAYE). Definer over the private hmrc schema, with its
-- own predicate.
create or replace view v_hmrc_sa_unmatched as
select sc.utr,
       sc.name           as hmrc_name,
       sc.your_reference,
       sc.statement_available,
       coalesce(sc.scope_reason, 'no_athena_record') as scope_reason,
       sc.first_seen,
       sc.last_seen,
       -- A name suggestion only, never a link: SA clients are individuals and
       -- 'KEYS M MISS' against 'Keys, Morag' is exactly the sort of guess that
       -- attributes one person's tax affairs to another. Staff decide.
       s.id   as suggested_entity_id,
       s.name as suggested_entity_name
  from hmrc.sa_client sc
  left join lateral (
    select e.id, e.name from entities e
     where e.entity_status = 'active'
       and regexp_replace(lower(e.name), '[^a-z0-9]', '', 'g')
         = regexp_replace(lower(sc.name), '[^a-z0-9]', '', 'g')
     order by e.name
     limit 1
  ) s on true
 where sc.entity_id is null
   and is_staff_or_service();

comment on view v_hmrc_sa_unmatched is 'Clients on HMRC''s Self Assessment agent list that match no live Athena client — we hold the authorisation for someone the client list does not know. The SA counterpart to hmrc.link_exception. suggested_entity is a name hint for a human to confirm, never an automatic link.';
grant select on v_hmrc_sa_unmatched to authenticated, service_role;
revoke all on v_hmrc_sa_unmatched from public;
revoke all on v_hmrc_sa_unmatched from anon;
