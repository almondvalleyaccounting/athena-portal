-- Maps each billing service_id (from live_billing.services[].service_id)
-- to either a canonical capacity-planner service (whose assignee is
-- resolved per-client via v_inferred_allocations) or to a default fee
-- earner that always handles it (e.g. Payroll → Stephanie).
--
-- Resolution order when computing "who earns this revenue":
--   1. mapping.default_fee_earner_id  (hard override, ignores client)
--   2. inferred allocation for (entity_id, mapping.canonical_service_id)
--   3. inferred allocation for (entity_id, 'accounts_submission')
--      (the catch-all fallback per user instruction)
CREATE TABLE IF NOT EXISTS billing_service_mappings (
  service_id text PRIMARY KEY,
  canonical_service_id text CHECK (canonical_service_id IN (
    'bookkeeping', 'vat_review', 'accounts_preparation',
    'accounts_submission', 'self_assessment'
  )),
  default_fee_earner_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff_profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS billing_service_mappings_canonical_idx
  ON billing_service_mappings (canonical_service_id);
