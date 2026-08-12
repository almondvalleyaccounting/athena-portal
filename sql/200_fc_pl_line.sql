-- ══════════════════════════════════════════════════════════════
-- 200_fc_pl_line.sql
--
-- Line items for the GENERAL CASHFLOW lens — the high-level model used
-- for ordinary trading companies (IT services, consultancies, trades),
-- as opposed to the detailed childcare pack which derives its P&L from
-- occupancy, ratios and rooms.
--
-- One row per forecast line (usually one QBO nominal account), seeded
-- from a client's QuickBooks P&L over a chosen window and then projected
-- forward. Per-scenario, so each VERSION owns its own set and versions
-- clone them like loans.
--
-- Projection per period t (0-based from the forecast's opening period):
--   override[t]  ?? ( basis(t) × (1 + uplift_pct/100) + delta_p )
--                    × (1 + growth_pct_pa/100) ^ (t/12)
-- where basis(t) is base_amount_p for 'average' | 'last' | 'manual',
-- and the seeded calendar-month shape for 'shape'.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fc_pl_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id   uuid NOT NULL REFERENCES public.fc_scenario(id) ON DELETE CASCADE,

  -- Generic categories — deliberately industry-neutral ("Sales", not
  -- "Private fees" / "Council income").
  category      text NOT NULL DEFAULT 'overheads'
                  CHECK (category IN ('income','cost_of_sales','payroll','overheads','capex')),
  label         text NOT NULL,

  -- QuickBooks provenance (null for hand-added lines)
  qbo_account_id   text,
  qbo_account_name text,
  qbo_group        text,          -- Income / COGS / Expenses / OtherExpenses …

  -- Seeded actuals: { "months": ["2025-09", …], "amounts_p": [123456, …] }
  -- Kept so the grid can show what the projection came from, and so the
  -- 'shape' method can repeat the calendar-month pattern.
  actuals       jsonb,

  -- Projection controls
  method        text NOT NULL DEFAULT 'average'
                  CHECK (method IN ('average','last','shape','manual','zero')),
  base_amount_p numeric NOT NULL DEFAULT 0,     -- monthly basis, always POSITIVE magnitude
  uplift_pct    numeric NOT NULL DEFAULT 0,     -- % applied to the basis
  delta_p       numeric NOT NULL DEFAULT 0,     -- absolute £p added per month (may be negative)
  growth_pct_pa numeric NOT NULL DEFAULT 0,     -- compounding annual growth
  overrides     jsonb,                          -- { "3": 250000 } period -> amount_p, wins outright
  start_month   integer NOT NULL DEFAULT 0,     -- first period this line applies
  end_month     integer,                        -- last period (null = to horizon)

  -- Cash behaviour
  vat_treatment text NOT NULL DEFAULT 'standard'
                  CHECK (vat_treatment IN ('standard','zero','exempt','outside')),
  cash_lag_days integer,                        -- null = category default from drivers

  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fc_pl_line_scenario_idx
  ON public.fc_pl_line (scenario_id, category, sort_order);

DROP TRIGGER IF EXISTS fc_pl_line_touch ON public.fc_pl_line;
CREATE TRIGGER fc_pl_line_touch BEFORE UPDATE ON public.fc_pl_line
  FOR EACH ROW EXECUTE FUNCTION public.fc_touch_updated_at();

ALTER TABLE public.fc_pl_line ENABLE ROW LEVEL SECURITY;

-- Mirrors fc_loan: portal admins only. Client forecasts carry client
-- financials, so this stays as tight as the rest of the fc_* tables.
DROP POLICY IF EXISTS fc_pl_line_admin_all ON public.fc_pl_line;
CREATE POLICY fc_pl_line_admin_all ON public.fc_pl_line
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_portal_admin = true)
  );
