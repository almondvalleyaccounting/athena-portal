-- 060_pd_tracker.sql
-- Personal Development Tracker: skill matrix, objectives, CPD log,
-- 1-2-1 meetings & actions, plus a team kudos wall.

-- 1. Skill matrix definitions (firm-wide)
CREATE TABLE IF NOT EXISTS pd_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  description text,
  max_level smallint NOT NULL DEFAULT 5,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pd_skills_category_idx ON pd_skills (category, display_order);

-- 2. Per-staff skill assessments
CREATE TABLE IF NOT EXISTS pd_skill_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES pd_skills(id) ON DELETE CASCADE,
  current_level smallint NOT NULL DEFAULT 0,
  target_level smallint NOT NULL DEFAULT 0,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, skill_id)
);
CREATE INDEX IF NOT EXISTS pd_skill_levels_staff_idx ON pd_skill_levels (staff_id);

-- 3. Personal objectives
CREATE TABLE IF NOT EXISTS pd_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','complete','abandoned')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high')),
  target_date date,
  progress_pct smallint NOT NULL DEFAULT 0,
  linked_skill_id uuid REFERENCES pd_skills(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pd_objectives_staff_idx ON pd_objectives (staff_id, status);

-- 4. CPD log
CREATE TABLE IF NOT EXISTS pd_cpd_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  title text NOT NULL,
  provider text,
  type text NOT NULL DEFAULT 'course'
    CHECK (type IN ('course','reading','webinar','conference','on_the_job','mentoring','other')),
  hours numeric(5,2) NOT NULL DEFAULT 0,
  reflection text,
  evidence_url text,
  linked_skill_id uuid REFERENCES pd_skills(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pd_cpd_staff_date_idx ON pd_cpd_entries (staff_id, entry_date DESC);

-- 5. 1-2-1 meetings
CREATE TABLE IF NOT EXISTS pd_one_to_ones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  manager_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  meeting_date date NOT NULL DEFAULT CURRENT_DATE,
  duration_mins int,
  what_went_well text,
  what_didnt text,
  blockers text,
  notes text,
  mood smallint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pd_one_to_ones_staff_idx ON pd_one_to_ones (staff_id, meeting_date DESC);

-- 6. 1-2-1 actions
CREATE TABLE IF NOT EXISTS pd_one_to_one_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  one_to_one_id uuid REFERENCES pd_one_to_ones(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','done','dropped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pd_actions_staff_idx ON pd_one_to_one_actions (staff_id, status);

-- 7. Kudos / shout-outs
CREATE TABLE IF NOT EXISTS pd_kudos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  to_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  message text NOT NULL,
  badge text DEFAULT 'star',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pd_kudos_to_idx ON pd_kudos (to_id, created_at DESC);

-- Seed skill matrix tailored to accountancy practice
INSERT INTO pd_skills (name, category, description, display_order)
SELECT * FROM (VALUES
  ('Bookkeeping & ledger work', 'Technical', 'Day-to-day posting, reconciliations, control accounts.', 10),
  ('Year-end accounts (Ltd Co)', 'Technical', 'Statutory accounts under FRS 102 1A / 105.', 20),
  ('Sole trader / partnership accounts', 'Technical', 'Unincorporated business accounts.', 30),
  ('Management accounts', 'Technical', 'Monthly/quarterly MI packs, KPIs, commentary.', 40),
  ('Cash flow & forecasting', 'Technical', 'Building forecasts, scenario planning.', 50),
  ('Corporation tax (CT600)', 'Tax & Compliance', 'CT computations, capital allowances, R&D awareness.', 60),
  ('Personal tax (SA100)', 'Tax & Compliance', 'Self assessment returns, employment, dividends, CGT basics.', 70),
  ('VAT returns & schemes', 'Tax & Compliance', 'Standard, FRS, cash, partial exemption.', 80),
  ('Payroll & PAYE', 'Tax & Compliance', 'Monthly payroll, RTI, P11D awareness.', 90),
  ('Companies House filing', 'Tax & Compliance', 'CS01, accounts filing, officer changes.', 100),
  ('Xero', 'Software', 'Setup, conversions, day-to-day, advanced features.', 110),
  ('QuickBooks Online', 'Software', 'Setup, conversions, day-to-day.', 120),
  ('Excel / Google Sheets', 'Software', 'Formulas, pivot tables, lookups, modelling.', 130),
  ('Power BI / data viz', 'Software', 'Dashboards, DAX, modelling.', 140),
  ('Athena portal mastery', 'Software', 'Confident use of our internal portal.', 150),
  ('Client communication', 'Soft Skills', 'Clear, empathetic, professional comms.', 160),
  ('Time & priority management', 'Soft Skills', 'Planning, focus, hitting deadlines.', 170),
  ('Mentoring & feedback', 'Soft Skills', 'Helping others grow.', 180),
  ('Problem solving', 'Soft Skills', 'Decomposing tricky issues, choosing approach.', 190),
  ('Commercial awareness', 'Soft Skills', 'Understanding client business drivers.', 200)
) AS s(name, category, description, display_order)
WHERE NOT EXISTS (SELECT 1 FROM pd_skills p WHERE p.name = s.name);

-- RLS: enable, allow authenticated (app-layer gating like other tables)
ALTER TABLE pd_skills              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_skill_levels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_objectives          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_cpd_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_one_to_ones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_one_to_one_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_kudos               ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'pd_skills','pd_skill_levels','pd_objectives','pd_cpd_entries',
    'pd_one_to_ones','pd_one_to_one_actions','pd_kudos'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I;', t || '_authenticated', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t || '_authenticated', t
    );
  END LOOP;
END $$;

-- Grant view permission to all active staff
UPDATE staff_profiles SET can_view_pd_tracker = true WHERE is_active = true;
