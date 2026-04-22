-- 036_entity_status_third_party.sql
-- Adds `third_party` to the entity_status enum.
--
-- Motivation: some invoiced counterparties aren't accountancy clients —
-- finance partners, insurance companies, ad-hoc asset buyers. They need
-- to receive invoices (and show up in revenue) without counting as
-- clients in KPIs like "Clients Without Billing", capacity planning,
-- benchmarks, or churn.
--
-- Postgres requires ALTER TYPE ADD VALUE to run outside a transaction
-- block, hence no BEGIN/COMMIT wrapper.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'entity_status' AND e.enumlabel = 'third_party'
  ) THEN
    ALTER TYPE entity_status ADD VALUE 'third_party';
  END IF;
END $$;
