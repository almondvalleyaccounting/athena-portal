-- ============================================================
-- Per-appointment CH officer/PSC ids on entity_people (16/07/2026).
--
-- people.ch_officer_id / ch_psc_id are single columns, but Companies House
-- assigns a DISTINCT officer/PSC id per company appointment — a genuine
-- multi-company director needs more than one. Merging such a person (see
-- project-ch-code-data-quality memory, Lewis Mckechnie) can only keep one
-- id on people, silently dropping the other company's id — so the next
-- "Re-sync all" Companies House refresh fails to recognise that company's
-- appointment (id lookup misses, and the strict name+DOB fallback can also
-- miss if the merged record's DOB reflects a different company's filing)
-- and inserts a brand-new duplicate person + chase, undoing the merge.
--
-- Fix: track the id per appointment on entity_people (already the
-- person×company join row) as well. ch-ingest-officers now checks
-- entity_people(entity_id, ch_officer_id/ch_psc_id) FIRST, before the
-- legacy people-level id and the name+DOB fallback, and writes the id back
-- onto entity_people on every ingest. people.ch_officer_id/ch_psc_id stay
-- as a "first seen" convenience field — no longer the only record.
-- ============================================================

alter table entity_people add column if not exists ch_officer_id text;
alter table entity_people add column if not exists ch_psc_id text;

create index if not exists idx_entity_people_ch_officer_id on entity_people(entity_id, ch_officer_id) where ch_officer_id is not null;
create index if not exists idx_entity_people_ch_psc_id on entity_people(entity_id, ch_psc_id) where ch_psc_id is not null;

-- Backfill from the current (single) people-level id. Correct for the vast
-- majority of single-company people; for anyone already merged across
-- multiple companies this best-effort backfill can only be right for one of
-- their companies — the Lewis Mckechnie case is corrected by hand below.
update entity_people ep set ch_officer_id = p.ch_officer_id
  from people p where p.id = ep.person_id and ep.source = 'ch_officers' and p.ch_officer_id is not null;

update entity_people ep set ch_psc_id = p.ch_psc_id
  from people p where p.id = ep.person_id and ep.source = 'ch_psc' and p.ch_psc_id is not null;

-- Lewis Mckechnie's Gnorth Properties appointment ids were lost when his
-- duplicate person record was merged (recovered from the pre-merge record,
-- captured before this fix existed).
update entity_people set ch_officer_id = 'svWt8A1Y_noudcuBsLpc92y-VWw'
  where entity_id = 'c4e574f6-7eb2-4856-9af4-189487cb7286'
    and person_id = '9d1c861c-1dac-4134-b010-481d2f697408' and role = 'director';

update entity_people set ch_psc_id = 'WvcTokkWzs6f-lAWSxk0e3cI6xo'
  where entity_id = 'c4e574f6-7eb2-4856-9af4-189487cb7286'
    and person_id = '9d1c861c-1dac-4134-b010-481d2f697408' and role = 'shareholder';
