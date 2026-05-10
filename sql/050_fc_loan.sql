-- ══════════════════════════════════════════════════════════════
-- 050_fc_loan.sql
--
-- Standalone loan instruments — bank facilities and director loans —
-- separate from the property mortgage handled by the premises module.
--
-- Each row: principal drawn at start_month, then either amortising
-- (fixed monthly payment with interest + principal split) or
-- interest-only (interest paid each month + balloon principal at term).
--
-- The loans engine module (TS) reads these per-scenario rows and emits
-- debt_interest, debt_principal, debt_balance with tags.loan_kind so
-- the financial core can split director vs long-term liabilities on the
-- balance sheet.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fc_loan (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id  uuid NOT NULL REFERENCES public.fc_scenario(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('bank', 'director')),
  label        text NOT NULL,
  principal_p  bigint NOT NULL,
  start_month  integer NOT NULL DEFAULT 0,
  term_months  integer NOT NULL DEFAULT 60,
  interest_pct numeric(6,3) NOT NULL DEFAULT 0,
  payment_kind text NOT NULL DEFAULT 'amortising'
                 CHECK (payment_kind IN ('amortising', 'interest_only')),
  notes        text,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fc_loan_scenario_idx ON public.fc_loan (scenario_id, sort_order);

DROP TRIGGER IF EXISTS fc_loan_touch ON public.fc_loan;
CREATE TRIGGER fc_loan_touch BEFORE UPDATE ON public.fc_loan
  FOR EACH ROW EXECUTE FUNCTION public.fc_touch_updated_at();

ALTER TABLE public.fc_loan ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fc_loan_admin_all ON public.fc_loan;
CREATE POLICY fc_loan_admin_all ON public.fc_loan
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_portal_admin = true)
  );
