-- Per-client opt-out from fee raises. When true, the Apply Uplift
-- modal on the Change page skips this client entirely — handy for
-- new clients still inside their introductory period, or clients
-- you've already committed to a fixed fee.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS fee_raise_excluded boolean NOT NULL DEFAULT false;

-- Strategy tag on each service's pending uplift, used as a priority
-- guard so a later bulk inflation pass never overwrites a manually-set
-- value. Lives in the services jsonb as pending_uplift_strategy
-- ('manual' | 'floor' | 'inflation'). No DDL needed — jsonb is
-- schemaless. This file documents the convention.

COMMENT ON COLUMN entities.fee_raise_excluded IS
  'When true, this client is excluded from bulk Apply Uplift (inflation/floor) on the Change matrix. Manual cell edits still work.';
