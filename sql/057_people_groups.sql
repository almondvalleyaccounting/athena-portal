-- 057_people_groups.sql
-- Person-centric model so we can compute "client groups" (entities sharing
-- a director / shareholder / sole trader / partner) and surface them in
-- the Allocations matrix.
--
-- Group definition: STRICT (only director/shareholder/sole_trader/partner
-- roles count) and ONE-DEGREE (no transitive closure).

-- 1. people: every individual we know about (CH officer, PSC, sole trader,
--    or manually added). Sole traders also appear in `entities` (linked
--    via entities.linked_person_id below).
CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  ni_number text,
  dob_year smallint,        -- CH only gives partial DOB; we store year + month
  dob_month smallint,
  ch_officer_id text,       -- CH officer appointment id, where applicable
  ch_psc_id text,           -- CH PSC notification id, where applicable
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','ch_officer','ch_psc','sole_trader_auto','partnership_auto')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Loose dedup helpers; we don't enforce uniqueness because CH partial data
-- means we sometimes can't tell two "John Smith" apart.
CREATE INDEX IF NOT EXISTS people_name_idx ON people (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS people_ch_officer_idx ON people (ch_officer_id) WHERE ch_officer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_ch_psc_idx ON people (ch_psc_id) WHERE ch_psc_id IS NOT NULL;

-- 2. entity_people: many-to-many. role drives whether a link counts toward
--    a strict group.
CREATE TABLE IF NOT EXISTS entity_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role text NOT NULL
    CHECK (role IN ('director','shareholder','sole_trader','partner','psc','contact')),
  role_pct numeric,         -- shareholding percentage where applicable
  is_primary_contact boolean NOT NULL DEFAULT false,
  started_on date,
  ended_on date,            -- NULL = still active
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','ch_officers','ch_psc','sole_trader_auto','partnership_auto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS entity_people_entity_idx ON entity_people (entity_id);
CREATE INDEX IF NOT EXISTS entity_people_person_idx ON entity_people (person_id);
CREATE INDEX IF NOT EXISTS entity_people_active_idx ON entity_people (entity_id, person_id) WHERE ended_on IS NULL;

-- 3. entities.linked_person_id: where the entity itself represents a
--    natural person (sole trader, individual SA client). Lets us show
--    "Graeme Duncan, sole trader" and "Graeme Duncan, director of WDF"
--    as the same person.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS linked_person_id uuid REFERENCES people(id);

-- 4. v_client_groups: per entity, the set of related entities through
--    strict, active links. A row exists for every (focal_entity, member_entity)
--    pair (including focal=member). Group label = the most-connecting
--    person's name.
CREATE OR REPLACE VIEW v_client_group_links AS
SELECT
  ep.entity_id,
  ep.person_id,
  p.name AS person_name
FROM entity_people ep
JOIN people p ON p.id = ep.person_id
WHERE ep.role IN ('director','shareholder','sole_trader','partner')
  AND ep.ended_on IS NULL;

-- All entity↔entity pairs that share at least one strict person link.
CREATE OR REPLACE VIEW v_client_group_pairs AS
SELECT DISTINCT
  a.entity_id     AS focal_entity_id,
  b.entity_id     AS member_entity_id,
  a.person_id     AS via_person_id,
  a.person_name   AS via_person_name
FROM v_client_group_links a
JOIN v_client_group_links b ON a.person_id = b.person_id;

-- For each focal entity, the group "label person" = the person id who
-- connects the most members. Ties broken by lowest person uuid.
CREATE OR REPLACE VIEW v_client_groups AS
WITH counts AS (
  SELECT
    focal_entity_id,
    via_person_id,
    via_person_name,
    COUNT(DISTINCT member_entity_id) AS member_count
  FROM v_client_group_pairs
  GROUP BY focal_entity_id, via_person_id, via_person_name
),
ranked AS (
  SELECT
    focal_entity_id,
    via_person_id   AS label_person_id,
    via_person_name AS label_person_name,
    member_count,
    ROW_NUMBER() OVER (
      PARTITION BY focal_entity_id
      ORDER BY member_count DESC, via_person_id
    ) AS rn
  FROM counts
)
SELECT
  r.focal_entity_id  AS entity_id,
  r.label_person_id,
  r.label_person_name,
  ARRAY(
    SELECT DISTINCT p.member_entity_id
    FROM v_client_group_pairs p
    WHERE p.focal_entity_id = r.focal_entity_id
  )                  AS member_entity_ids
FROM ranked r
WHERE rn = 1;

-- 5. RLS: open to authenticated users (consistent with other planner tables).
ALTER TABLE people        ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_people ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "people_all"        ON people;
DROP POLICY IF EXISTS "entity_people_all" ON entity_people;
CREATE POLICY "people_all" ON people
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "entity_people_all" ON entity_people
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 6. Auto-seed sole traders + partnerships into people. Each row creates
--    a person from the entity name and links it. Idempotent — re-running
--    has no effect because of the unique constraint on entity_people.
DO $$
DECLARE
  e RECORD;
  pid uuid;
BEGIN
  FOR e IN
    SELECT id, name, type FROM entities
    WHERE type IN ('sole_trader','partnership')
      AND linked_person_id IS NULL
  LOOP
    INSERT INTO people (name, source)
    VALUES (e.name, CASE WHEN e.type = 'sole_trader' THEN 'sole_trader_auto' ELSE 'partnership_auto' END)
    RETURNING id INTO pid;

    UPDATE entities SET linked_person_id = pid WHERE id = e.id;

    INSERT INTO entity_people (entity_id, person_id, role, source, is_primary_contact)
    VALUES (e.id, pid, CASE WHEN e.type = 'sole_trader' THEN 'sole_trader' ELSE 'partner' END,
                       CASE WHEN e.type = 'sole_trader' THEN 'sole_trader_auto' ELSE 'partnership_auto' END,
                       true)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
