-- 253: Put the SA authorisations we hold for non-clients on the Authorisations
-- screen, which was built for exactly this and has been empty.
--
-- Publishing the whole SA client list (sql/252) surfaced 25 people HMRC says we
-- act for who are not live Athena clients: 22 with no Athena record at all and
-- 3 whose record is archived. Athena already has the right home for these —
-- hmrc.disengage, rendered by /hmrc → Authorisations, whose reason vocabulary
-- (no_athena_record / archived / nlac) is already the vocabulary sql/252 wrote
-- into sa_client.scope_reason. It had no rows because only PAYE ever fed it.
--
-- As that screen's own comment puts it, these pull in two directions: an
-- authorisation we should have handed back is a liability, because we can still
-- see — and be assumed responsible for — a taxpayer we do not act for; and one
-- we should NOT hand back means the client record is wrong. So each row is a
-- decision, not a defect.
--
-- The table was PAYE-shaped: paye_ref NOT NULL, unique on (service, paye_ref).
-- An SA taxpayer has a UTR and no PAYE reference, so it is generalised. Safe to
-- restructure freely — the table is empty.
alter table hmrc.disengage
  add column if not exists utr text;

alter table hmrc.disengage
  alter column paye_ref drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'hmrc.disengage'::regclass
                    and conname = 'disengage_has_a_reference') then
    alter table hmrc.disengage
      add constraint disengage_has_a_reference
      check (paye_ref is not null or utr is not null);
  end if;
end $$;

-- One open row per taxpayer per tax, whichever reference identifies them.
alter table hmrc.disengage drop constraint if exists disengage_service_paye_ref_key;
create unique index if not exists disengage_service_reference_key
  on hmrc.disengage (service, coalesce(paye_ref, utr));

comment on column hmrc.disengage.utr is 'The taxpayer reference for services identified by UTR (Self Assessment, Corporation Tax). paye_ref holds it for PAYE. Exactly one of the two is set.';

-- The view keeps emitting paye_ref so the existing screen needs no change; for
-- an SA row that is the UTR. utr is exposed separately for anything new.
create or replace view v_hmrc_authorisation_review as
select id,
       service,
       coalesce(paye_ref, utr) as paye_ref,
       hmrc_name,
       entity_id,
       entity_name,
       reason,
       round(coalesce(last_known_debt, 0)::numeric / 100.0, 2) as last_known_debt,
       first_flagged,
       last_seen_on_list,
       current_date - first_flagged::date as days_outstanding,
       removed_at,
       removed_by,
       note,
       -- appended, so create-or-replace does not have to rename a column
       utr
  from hmrc.disengage d
 where hmrc_can_read();

comment on view v_hmrc_authorisation_review is 'HMRC authorisations with no live Athena client behind them, for PAYE (paye_ref) and Self Assessment (utr). paye_ref is a coalesce so the Authorisations screen renders both without change.';
grant select on v_hmrc_authorisation_review to authenticated, service_role;
revoke all on v_hmrc_authorisation_review from public;
revoke all on v_hmrc_authorisation_review from anon;

-- ── The 25 from the SA list ──────────────────────────────────────────────
-- last_known_debt stays null: these were never scraped, so we have never seen
-- what they owe. The note carries the two facts that make a decision possible —
-- HMRC's own reference, which for our older records contains the person's name
-- (KarenDillon, SamHenderson, DerekLogan), and whether a live client shares the
-- surname. That last one is a coincidence to check, never a link: 'STEWART D MR'
-- and 'STEWART D W MR' are two different taxpayers who would both "match"
-- Stewart, Derek.
insert into hmrc.disengage
  (service, paye_ref, utr, hmrc_name, entity_id, entity_name, reason,
   last_known_debt, first_flagged, last_seen_on_list, note)
select 'self-assessment',
       null,
       sc.utr,
       sc.name,
       null,
       null,
       coalesce(sc.scope_reason, 'no_athena_record'),
       null,
       now(),
       coalesce(sc.last_seen, now()),
       'HMRC reference ' || coalesce(nullif(sc.your_reference, 'null'), '(none)')
         || '. On HMRC''s SA list with a statement we have never read.'
         || coalesce(
              ' Live clients sharing the surname: ' || (
                select string_agg(e.name, ', ' order by e.name)
                  from entities e
                 where e.entity_status = 'active'
                   and lower(split_part(e.name, ',', 1))
                     = lower(split_part(btrim(sc.name), ' ', 1))
              ) || ' — a coincidence to check, not a link.',
              '')
  from hmrc.sa_client sc
 where sc.entity_id is null
on conflict (service, coalesce(paye_ref, utr)) do nothing;
