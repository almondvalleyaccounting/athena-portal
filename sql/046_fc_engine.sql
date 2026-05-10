-- ══════════════════════════════════════════════════════════════
-- 046_fc_engine.sql
--
-- Forecast engine — phase 1 (schema + Scotland LA seed).
--
-- A new module that lives alongside the existing `planning` module
-- (AVA practice planning). The forecast engine is generic — it ships
-- with vertical "packs" (childcare_scotland in v1, accountancy in v2)
-- but the schema knows nothing about them. Modules and their drivers
-- are declared in TS code, not in SQL.
--
-- Data shape:
--   fc_forecast    — top-level workspace
--     fc_version   — copy-on-write snapshot or live working set
--       fc_scenario — base + named variants (overrides only)
--         fc_driver / fc_driver_value — assumptions (timeseries or scalar)
--         fc_output — materialised P&L/BS/Cashflow/decision rows
--         fc_finding — sanity / reconciliation / ratio findings
--     fc_entity    — locations (or other vertical-specific entities)
--
-- Money: integer pence everywhere. Period: integer month index from
-- forecast.opening_period (0 = opening month). Conversion to GBP/date
-- happens in the UI.
--
-- LA lookup tables sit outside the forecast hierarchy — they're
-- shared reference data populated by hand and reused across forecasts.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────
-- LA reference data (Scotland, v1 priority councils)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_la_council (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  country     text NOT NULL DEFAULT 'scotland',
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Funded hourly rate per age band, per period (period_year as YYYY).
-- age_band: 'babies' | 'twos' | 'three_to_five' | 'after_school'
CREATE TABLE IF NOT EXISTS public.fc_la_funded_rate (
  la_council_id  uuid NOT NULL REFERENCES public.fc_la_council(id) ON DELETE CASCADE,
  period_year    integer NOT NULL,
  age_band       text NOT NULL,
  hourly_rate_p  bigint NOT NULL,            -- pence
  notes          text,
  PRIMARY KEY (la_council_id, period_year, age_band)
);

-- NDR (non-domestic rates) multiplier and reliefs per LA per year.
CREATE TABLE IF NOT EXISTS public.fc_la_ndr (
  la_council_id   uuid NOT NULL REFERENCES public.fc_la_council(id) ON DELETE CASCADE,
  period_year     integer NOT NULL,
  poundage        numeric(6,5) NOT NULL,     -- e.g. 0.498 for 49.8p
  small_business_relief_pct numeric(5,2),    -- if rateable value qualifies
  notes           text,
  PRIMARY KEY (la_council_id, period_year)
);

-- Top-up policy: whether parents can be charged above the funded rate
-- for funded hours, and any per-LA notes.
CREATE TABLE IF NOT EXISTS public.fc_la_topup (
  la_council_id  uuid PRIMARY KEY REFERENCES public.fc_la_council(id) ON DELETE CASCADE,
  topup_allowed  boolean NOT NULL DEFAULT false,
  notes          text
);

-- Seed v1 priority councils. Rates intentionally NULL — populate when
-- you have the published 2026/27 figures to hand.
INSERT INTO public.fc_la_council (code, name) VALUES
  ('GLA', 'Glasgow City'),
  ('NLA', 'North Lanarkshire'),
  ('EDB', 'East Dunbartonshire'),
  ('WDB', 'West Dunbartonshire')
ON CONFLICT (code) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- fc_forecast — top-level workspace
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_forecast (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  vertical_pack   text NOT NULL,             -- 'childcare_scotland' | 'accountancy' | 'simple'
  horizon_months  integer NOT NULL DEFAULT 60,
  opening_period  date NOT NULL,             -- first day of opening month
  currency        text NOT NULL DEFAULT 'GBP',
  notes           text,
  created_by      uuid REFERENCES public.staff_profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────
-- fc_version — copy-on-write versioning
--   kind = 'working': the editable live set; one per forecast
--   kind = 'snapshot': frozen named version
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_version (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id        uuid NOT NULL REFERENCES public.fc_forecast(id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('working','snapshot')),
  parent_version_id  uuid REFERENCES public.fc_version(id),
  comment            text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fc_version_forecast_idx
  ON public.fc_version (forecast_id, kind, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- fc_scenario — base + named variants under a version
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_scenario (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          uuid NOT NULL REFERENCES public.fc_version(id) ON DELETE CASCADE,
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('base','named')),
  parent_scenario_id  uuid REFERENCES public.fc_scenario(id),  -- NULL for base
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, name)
);

CREATE INDEX IF NOT EXISTS fc_scenario_version_idx
  ON public.fc_scenario (version_id, kind);

-- One base scenario per version (enforced via partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS fc_scenario_one_base_per_version
  ON public.fc_scenario (version_id) WHERE kind = 'base';

-- ────────────────────────────────────────────────────────────
-- fc_entity — locations for childcare; generic for other packs
--
-- config jsonb shape for childcare_scotland location:
--   {
--     "la_council_id": "...",
--     "sq_ft": 4200,
--     "capacity_by_age_band": { "babies": 12, "twos": 16, "three_to_five": 32 },
--     "opening_month_offset": 0,         -- months from forecast start
--     "acquisition_type": "greenfield" | "acquired_going_concern" | "acquired_empty",
--     "lease_or_buy": "lease" | "buy"
--   }
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_entity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id  uuid NOT NULL REFERENCES public.fc_forecast(id) ON DELETE CASCADE,
  key          text NOT NULL,             -- stable slug, e.g. 'site_glasgow_west'
  label        text NOT NULL,
  type         text NOT NULL DEFAULT 'location',
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (forecast_id, key)
);

CREATE INDEX IF NOT EXISTS fc_entity_forecast_idx
  ON public.fc_entity (forecast_id, sort_order);

-- ────────────────────────────────────────────────────────────
-- Tag / dimension system (n-dim cross-cuts)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_dimension (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id  uuid NOT NULL REFERENCES public.fc_forecast(id) ON DELETE CASCADE,
  key          text NOT NULL,
  label        text NOT NULL,
  UNIQUE (forecast_id, key)
);

CREATE TABLE IF NOT EXISTS public.fc_dimension_value (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension_id  uuid NOT NULL REFERENCES public.fc_dimension(id) ON DELETE CASCADE,
  key           text NOT NULL,
  label         text NOT NULL,
  UNIQUE (dimension_id, key)
);

CREATE TABLE IF NOT EXISTS public.fc_entity_tag (
  entity_id           uuid NOT NULL REFERENCES public.fc_entity(id) ON DELETE CASCADE,
  dimension_value_id  uuid NOT NULL REFERENCES public.fc_dimension_value(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, dimension_value_id)
);

-- ────────────────────────────────────────────────────────────
-- fc_driver — assumptions
--
-- Resolution: a scenario inherits its parent's drivers. Named scenarios
-- store overrides only; lookup falls back to the base scenario when
-- no row exists for the (driver_key, entity_id, scenario_id) triple.
--
-- kind:
--   'scalar'      — one fc_driver_value row, period = NULL
--   'timeseries'  — many fc_driver_value rows, one per month
--   'linked'      — no fc_driver_value rows; expression evaluated by engine
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_driver (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id   uuid NOT NULL REFERENCES public.fc_scenario(id) ON DELETE CASCADE,
  entity_id     uuid REFERENCES public.fc_entity(id) ON DELETE CASCADE,  -- NULL = group-level
  module_key    text NOT NULL,             -- e.g. 'services_childcare'
  driver_key    text NOT NULL,             -- semantic, e.g. 'weekly_rate.babies'
  label         text NOT NULL,
  unit          text NOT NULL,             -- 'gbp_p' | 'pct' | 'count' | 'hours' | 'sqft' | 'ratio'
  kind          text NOT NULL CHECK (kind IN ('scalar','timeseries','linked')),
  expression    text,                       -- only for kind='linked'
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, entity_id, module_key, driver_key)
);

CREATE INDEX IF NOT EXISTS fc_driver_scenario_module_idx
  ON public.fc_driver (scenario_id, module_key);
CREATE INDEX IF NOT EXISTS fc_driver_entity_idx
  ON public.fc_driver (entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fc_driver_value (
  driver_id  uuid NOT NULL REFERENCES public.fc_driver(id) ON DELETE CASCADE,
  period     integer NOT NULL DEFAULT -1, -- -1 for scalar; >=0 month index for timeseries
  value      numeric(20,6) NOT NULL,      -- generic numeric; engine interprets via unit
  PRIMARY KEY (driver_id, period)
);

CREATE TABLE IF NOT EXISTS public.fc_driver_tag (
  driver_id           uuid NOT NULL REFERENCES public.fc_driver(id) ON DELETE CASCADE,
  dimension_value_id  uuid NOT NULL REFERENCES public.fc_dimension_value(id) ON DELETE CASCADE,
  PRIMARY KEY (driver_id, dimension_value_id)
);

-- ────────────────────────────────────────────────────────────
-- fc_output — materialised module outputs
--
-- Replaced wholesale on each recompute for a (scenario_id) tuple.
-- Reads are dashboard queries: sum/group by nominal_type / entity / period.
--
-- nominal_type: enumerated below. amount_p in pence (signed).
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_output (
  id            bigserial PRIMARY KEY,
  scenario_id   uuid NOT NULL REFERENCES public.fc_scenario(id) ON DELETE CASCADE,
  entity_id     uuid REFERENCES public.fc_entity(id) ON DELETE CASCADE,
  period        integer NOT NULL,
  module_key    text NOT NULL,
  nominal_type  text NOT NULL,
  line_label    text NOT NULL,
  amount_p      bigint NOT NULL,
  tags          jsonb
);

CREATE INDEX IF NOT EXISTS fc_output_scenario_period_idx
  ON public.fc_output (scenario_id, period);
CREATE INDEX IF NOT EXISTS fc_output_scenario_nominal_idx
  ON public.fc_output (scenario_id, nominal_type, period);
CREATE INDEX IF NOT EXISTS fc_output_entity_idx
  ON public.fc_output (entity_id) WHERE entity_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- fc_finding — validation findings (sanity, ratio, reconciliation)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fc_finding (
  id          bigserial PRIMARY KEY,
  scenario_id uuid NOT NULL REFERENCES public.fc_scenario(id) ON DELETE CASCADE,
  entity_id   uuid REFERENCES public.fc_entity(id) ON DELETE CASCADE,
  period      integer,
  severity    text NOT NULL CHECK (severity IN ('info','warn','error')),
  code        text NOT NULL,
  message     text NOT NULL
);

CREATE INDEX IF NOT EXISTS fc_finding_scenario_idx
  ON public.fc_finding (scenario_id, severity);


-- ────────────────────────────────────────────────────────────
-- updated_at triggers
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fc_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fc_forecast_touch ON public.fc_forecast;
CREATE TRIGGER fc_forecast_touch BEFORE UPDATE ON public.fc_forecast
  FOR EACH ROW EXECUTE FUNCTION public.fc_touch_updated_at();

DROP TRIGGER IF EXISTS fc_entity_touch ON public.fc_entity;
CREATE TRIGGER fc_entity_touch BEFORE UPDATE ON public.fc_entity
  FOR EACH ROW EXECUTE FUNCTION public.fc_touch_updated_at();

DROP TRIGGER IF EXISTS fc_driver_touch ON public.fc_driver;
CREATE TRIGGER fc_driver_touch BEFORE UPDATE ON public.fc_driver
  FOR EACH ROW EXECUTE FUNCTION public.fc_touch_updated_at();


-- ────────────────────────────────────────────────────────────
-- RLS — solo-user tool, gated on portal admin
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'fc_la_council','fc_la_funded_rate','fc_la_ndr','fc_la_topup',
    'fc_forecast','fc_version','fc_scenario','fc_entity',
    'fc_dimension','fc_dimension_value','fc_entity_tag',
    'fc_driver','fc_driver_value','fc_driver_tag',
    'fc_output','fc_finding'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %1$I_admin_all ON public.%1$I;
      CREATE POLICY %1$I_admin_all ON public.%1$I
        FOR ALL USING (
          EXISTS (SELECT 1 FROM public.staff_profiles sp
                  WHERE sp.id = auth.uid() AND sp.is_portal_admin = true)
        );
    $p$, t);
  END LOOP;
END $$;

COMMIT;
