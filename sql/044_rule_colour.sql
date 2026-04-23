-- ══════════════════════════════════════════════════════════════
-- 044_rule_colour.sql
--
-- Adds a colour field to each scheduling rule. Used to tint task
-- cards in the Waiting tab so each task type is instantly
-- recognisable at a glance.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.bm_scheduling_rules
  ADD COLUMN IF NOT EXISTS colour text;

COMMENT ON COLUMN public.bm_scheduling_rules.colour IS
  'Hex colour (e.g. #ffd166) used to tint Waiting-tab task cards for this task type. Null = default grey.';
