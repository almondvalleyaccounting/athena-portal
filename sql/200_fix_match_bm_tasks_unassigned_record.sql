-- ══════════════════════════════════════════════════════════════
-- 200_fix_match_bm_tasks_unassigned_record.sql
--
-- Fix: BM Tasks import preview died with
--        ERROR 55000: record "alias" is not assigned yet
--
-- Cause (sql/035): match_bm_tasks declares ent/alias/existing as
-- bare `record` and resets them each iteration with `x := NULL`.
-- In plpgsql, assigning NULL to a *record* returns it to the
-- not-yet-assigned state — the tuple structure is indeterminate,
-- so any field reference raises 55000. The three SELECT ... INTO
-- statements that would re-assign them are each wrapped in an IF
-- guard, so whenever the source column is blank the record stays
-- unassigned. jsonb_build_object then evaluates alias.staff_profile_id
-- unconditionally (CASE laziness doesn't help — every argument is
-- evaluated) and the whole preview aborts.
--
-- In practice: any BM task row with no assignee blew up the entire
-- preview. Same latent bug on `ent` (blank Client Reference) and
-- `existing` (blank bm_task_id).
--
-- Fix: drop the NULL resets and the IF guards. SELECT ... INTO always
-- runs, so the record is always assigned — a row of NULLs when nothing
-- matches, which is exactly what the downstream expressions expect.
-- The blank-key cases are folded into the WHERE via NULLIF, so they
-- match nothing (and cost an index probe on a NULL key, nothing more).
--
-- `rule` is declared as public.bm_scheduling_rules (a named composite,
-- not `record`), so NULL assignment is safe there and is left alone.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.match_bm_tasks(rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  result jsonb := '[]'::jsonb;
  r jsonb;
  ent record;
  alias record;
  rule public.bm_scheduling_rules;
  existing record;
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(rows)
  LOOP
    rule := NULL;   -- named composite type: safe to null, fields read as NULL

    -- Entity lookup by bm_client_id (Client Reference).
    -- Unguarded on purpose: a NULL key matches nothing and leaves
    -- `ent` assigned-but-NULL rather than unassigned.
    SELECT id, name INTO ent
    FROM entities
    WHERE bm_client_id = NULLIF(r->>'client_reference', '')
    LIMIT 1;

    -- Assignee lookup (read-only for preview; no upsert in preview path)
    SELECT staff_profile_id, display_name, active INTO alias
    FROM bm_staff_aliases
    WHERE bm_assignee_name = LOWER(TRIM(NULLIF(r->>'assignee_name', '')));

    -- Rule match
    IF NULLIF(r->>'task_name', '') IS NOT NULL THEN
      rule := match_bm_rule(r->>'task_name');
    END IF;

    -- Existing schedule row (for idempotency preview)
    SELECT state, manually_overridden_at, scheduled_for_date, assignee_id
      INTO existing
    FROM bm_task_schedule
    WHERE bm_task_id = NULLIF(r->>'bm_task_id', '');

    result := result || jsonb_build_object(
      'bm_task_id',         r->>'bm_task_id',
      'entity_id',          ent.id,
      'entity_name',        ent.name,
      'entity_match',       CASE WHEN ent.id IS NOT NULL THEN 'found' ELSE 'missing' END,
      'assignee_id',        alias.staff_profile_id,
      'assignee_display',   COALESCE(alias.display_name, NULLIF(TRIM(r->>'assignee_name'), '')),
      'assignee_match',     CASE
                              WHEN NULLIF(TRIM(r->>'assignee_name'),'') IS NULL THEN 'none'
                              WHEN alias.staff_profile_id IS NOT NULL THEN 'found'
                              WHEN alias.display_name IS NOT NULL THEN 'alias_only'
                              ELSE 'new_alias'
                            END,
      'rule_id',            rule.id,
      'rule_name',          rule.name,
      'rule_match',         CASE WHEN rule.id IS NOT NULL THEN 'found' ELSE 'missing' END,
      'existing_state',     existing.state,
      'manually_overridden',(existing.manually_overridden_at IS NOT NULL)
    );
  END LOOP;

  RETURN result;
END $fn$;

GRANT EXECUTE ON FUNCTION public.match_bm_tasks(jsonb) TO authenticated;
