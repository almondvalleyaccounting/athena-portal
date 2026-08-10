-- 1-2-1 discussion points as real records.
--
-- The four sections (went well / areas to target / blockers / notes) were
-- single free-text columns, and people were simulating rows by typing "- "
-- bullets into them. Each point now gets its own row with a headline (what
-- shows on the summary tile) and an optional detail (revealed on hover, and
-- printed in full on the PDF).
--
-- pd_one_to_ones.what_went_well/what_didnt/blockers/notes are KEPT and are
-- maintained by the app as a plain-text rendering of these rows, so the
-- dashboard teaser and the 360-feedback request keep reading a single field.
-- The rows here are the source of truth; those columns are derived.

create table if not exists pd_one_to_one_points (
  id             uuid primary key default gen_random_uuid(),
  one_to_one_id  uuid not null references pd_one_to_ones(id) on delete cascade,
  section        text not null check (section in ('went_well', 'improve', 'blockers', 'notes')),
  headline       text not null,
  detail         text,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists pd_one_to_one_points_meeting_idx
  on pd_one_to_one_points (one_to_one_id, section, sort_order);

alter table pd_one_to_one_points enable row level security;

-- Mirrors pd_one_to_ones: visible to all active staff. (pd_prep_notes is the
-- only pd_* table with tighter rules and this is not one of them.)
drop policy if exists pd_one_to_one_points_authenticated on pd_one_to_one_points;
create policy pd_one_to_one_points_authenticated on pd_one_to_one_points
  for all to authenticated
  using (is_active_staff())
  with check (is_active_staff());

-- ── Backfill: split the existing hand-typed bullets into rows ──────────────
-- One row per non-empty line, leading "-"/"*"/"•" and whitespace stripped.
-- Detail is left empty; the headline carries what was written.
insert into pd_one_to_one_points (one_to_one_id, section, headline, sort_order)
select
  m.id,
  s.section,
  btrim(regexp_replace(line, '^\s*[-*•]\s*', '')) as headline,
  (row_number() over (partition by m.id, s.section order by ord)) - 1 as sort_order
from pd_one_to_ones m
cross join lateral (
  values
    ('went_well', m.what_went_well),
    ('improve',   m.what_didnt),
    ('blockers',  m.blockers),
    ('notes',     m.notes)
) as s(section, body)
cross join lateral unnest(string_to_array(coalesce(s.body, ''), E'\n')) with ordinality as t(line, ord)
where btrim(regexp_replace(line, '^\s*[-*•]\s*', '')) <> ''
  and not exists (
    select 1 from pd_one_to_one_points p
    where p.one_to_one_id = m.id and p.section = s.section
  );
