-- ══════════════════════════════════════════════════════════════
-- 035_bm_tasks_import.sql
--
-- BrightManager Tasks import pipeline.
--
-- Adds:
--   • bm_staff_aliases          — map BM assignee names to staff_profiles
--                                  (or leave dangling for later invite)
--   • Expanded flag CHECK       — adds completed_under_expected flag
--   • Helper SQL functions      — date parsing, rule matching, scheduling
--   • match_bm_tasks(rows)      — dry-run preview RPC
--   • import_bm_tasks(run, p)   — single-tx commit RPC
--
-- Design rules preserved from 034:
--   • Additive only — no ALTERs on pre-034 tables except the
--     bm_reconciliation_flags.flag_type CHECK (we own that table).
--   • Assignee mirrors BM every import; time is sticky on manual
--     override; deadline moves flag but don't auto-reschedule after
--     a manual override.
--   • CSV export contains OPEN tasks only. Disappearance = completion.
--     On disappearance: sum timesheet via source_task_id FK;
--       – 0 hours              → completed_no_time flag
--       – < scheduled − 1h     → completed_under_expected flag
--       – otherwise            → silently mark state='completed'
--   • Unknown client_reference → entity_not_found flag (visible in
--     reconciliation inbox so manager runs a Clients import).
--   • Unknown task_name prefix → no_rule_match flag.
-- ══════════════════════════════════════════════════════════════

BEGIN;


-- ────────────────────────────────────────────────────────────
-- 1. bm_staff_aliases
--
-- Rationale: staff_profiles.id is FK to auth.users ON DELETE CASCADE,
-- so every staff_profiles row requires an auth account. BM contains
-- staff we haven't invited to Athena yet. This table lets us preserve
-- attribution without side-effecting auth. When someone is later
-- invited properly, set staff_profile_id to their new id and
-- historical bm_task_schedule rows keep working.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bm_staff_aliases (
  bm_assignee_name  text PRIMARY KEY,      -- case-insensitive match via LOWER()
  staff_profile_id  uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
  display_name      text,                   -- pretty name for UI
  active            boolean NOT NULL DEFAULT true,
  notes             text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bm_staff_aliases_staff_idx
  ON public.bm_staff_aliases (staff_profile_id);

ALTER TABLE public.bm_staff_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY bm_staff_aliases_read ON public.bm_staff_aliases
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid() AND sp.is_active = true)
  );

CREATE POLICY bm_staff_aliases_write ON public.bm_staff_aliases
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp
            WHERE sp.id = auth.uid()
              AND (sp.is_portal_admin = true OR sp.can_import_data = true))
  );

DROP TRIGGER IF EXISTS trg_bm_staff_aliases_updated_at ON public.bm_staff_aliases;
CREATE TRIGGER trg_bm_staff_aliases_updated_at
  BEFORE UPDATE ON public.bm_staff_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────
-- 2. Expand flag_type to include completed_under_expected
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.bm_reconciliation_flags
  DROP CONSTRAINT IF EXISTS bm_reconciliation_flags_flag_type_check;

ALTER TABLE public.bm_reconciliation_flags
  ADD CONSTRAINT bm_reconciliation_flags_flag_type_check
    CHECK (flag_type IN (
      'no_rule_match',
      'entity_not_found',
      'completed_no_time',
      'completed_under_expected',
      'deadline_moved',
      'cancelled_in_bm'
    ));


-- ────────────────────────────────────────────────────────────
-- 3. Helper functions
-- ────────────────────────────────────────────────────────────

-- Parse DD/MM/YYYY or YYYY-MM-DD. Returns NULL on any failure.
CREATE OR REPLACE FUNCTION public.parse_bm_date(raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  t text;
BEGIN
  t := NULLIF(TRIM(raw), '');
  IF t IS NULL THEN RETURN NULL; END IF;
  IF t ~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN t::date;
  ELSIF t ~ '^\d{2}/\d{2}/\d{4}$' THEN
    RETURN to_date(t, 'DD/MM/YYYY');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $fn$;


-- First-match prefix rule lookup, ordered by match_priority DESC.
CREATE OR REPLACE FUNCTION public.match_bm_rule(task_name text)
RETURNS public.bm_scheduling_rules
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  result public.bm_scheduling_rules;
BEGIN
  SELECT * INTO result
  FROM public.bm_scheduling_rules
  WHERE active = true
    AND task_name ILIKE task_name_prefix || '%'
  ORDER BY match_priority DESC, length(task_name_prefix) DESC, created_at ASC
  LIMIT 1;
  RETURN result;
END $fn$;


-- Resolve a BM assignee name to a staff_profiles.id via alias table.
-- Upserts the alias row on every call (for last_seen tracking and to
-- auto-register unknown names for later manual mapping).
-- Returns NULL if the alias has no staff_profile_id yet.
CREATE OR REPLACE FUNCTION public.resolve_bm_assignee(raw_name text)
RETURNS uuid
LANGUAGE plpgsql
AS $fn$
DECLARE
  cleaned text;
  resolved uuid;
BEGIN
  cleaned := NULLIF(TRIM(raw_name), '');
  IF cleaned IS NULL THEN RETURN NULL; END IF;

  -- Case-insensitive upsert on LOWER(name)
  INSERT INTO public.bm_staff_aliases (bm_assignee_name, display_name, last_seen_at)
  VALUES (LOWER(cleaned), cleaned, now())
  ON CONFLICT (bm_assignee_name) DO UPDATE SET
    last_seen_at = now(),
    display_name = COALESCE(public.bm_staff_aliases.display_name, EXCLUDED.display_name)
  RETURNING staff_profile_id INTO resolved;

  RETURN resolved;
END $fn$;


-- Compute scheduling date given rule + deadline/target.
-- Algorithm:
--   1. anchor = deadline or target_date (deadline wins)
--   2. target = anchor - lead_time_days
--   3. if preferred_dow set, snap target forward within its ISO week
--      to that weekday (e.g. if target is Wed and pref is Mon, roll
--      back to the Mon of the same week — we want the scheduled slot
--      to sit BEFORE the deadline target, not after it)
--   4. if no anchor (no deadline, no target) and preferred_week_of_month
--      is set, schedule in the preferred week of the current month
--      as a fallback (rare; mostly happens for recurring tasks with
--      neither deadline nor target filled in)
CREATE OR REPLACE FUNCTION public.compute_bm_schedule_date(
  rule_lead_time_days  integer,
  rule_preferred_dow   text,
  rule_preferred_week  smallint,
  deadline             date,
  target_date          date
)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  anchor date;
  target date;
  dow_target int;
  dow_actual int;
  diff int;
BEGIN
  anchor := COALESCE(deadline, target_date);

  IF anchor IS NOT NULL THEN
    target := anchor - rule_lead_time_days;
    IF rule_preferred_dow IS NOT NULL THEN
      dow_target := CASE rule_preferred_dow
        WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3
        WHEN 'thu' THEN 4 WHEN 'fri' THEN 5
      END;
      dow_actual := EXTRACT(ISODOW FROM target);
      diff := dow_target - dow_actual;
      -- Forward-only snap (planning looks forward, never back).
      -- If the preferred DOW is earlier in the week than target,
      -- move to NEXT week's preferred DOW.
      IF diff < 0 THEN diff := diff + 7; END IF;
      -- Don't let the snap push past the deadline. If it would,
      -- keep target as-is (lead_time already gave a safe anchor).
      IF deadline IS NOT NULL AND target + diff > deadline THEN
        NULL;
      ELSE
        target := target + diff;
      END IF;
    END IF;
    RETURN target;
  END IF;

  -- No anchor — fallback to preferred week of current month
  IF rule_preferred_week IS NOT NULL THEN
    -- 1st day of current month
    anchor := date_trunc('month', CURRENT_DATE)::date;
    -- Add (week-1) * 7 days
    RETURN anchor + (COALESCE(rule_preferred_week, 1) - 1) * 7;
  END IF;

  RETURN NULL;
END $fn$;


-- ────────────────────────────────────────────────────────────
-- 4. match_bm_tasks — dry-run preview RPC
--
-- Input:  { rows: [ { bm_task_id, client_reference, assignee_name,
--                     task_name, deadline, target_date } ] }
-- Output: [ { bm_task_id, entity_id, entity_name, entity_match,
--             assignee_id, assignee_display, assignee_match,
--             rule_id, rule_name, rule_match,
--             existing_state, manually_overridden } ]
-- ────────────────────────────────────────────────────────────
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
    ent := NULL; alias := NULL; rule := NULL; existing := NULL;

    -- Entity lookup by bm_client_id (Client Reference)
    IF NULLIF(r->>'client_reference', '') IS NOT NULL THEN
      SELECT id, name INTO ent
      FROM entities
      WHERE bm_client_id = r->>'client_reference'
      LIMIT 1;
    END IF;

    -- Assignee lookup (read-only for preview; no upsert in preview path)
    IF NULLIF(r->>'assignee_name', '') IS NOT NULL THEN
      SELECT staff_profile_id, display_name, active INTO alias
      FROM bm_staff_aliases
      WHERE bm_assignee_name = LOWER(TRIM(r->>'assignee_name'));
    END IF;

    -- Rule match
    IF NULLIF(r->>'task_name', '') IS NOT NULL THEN
      rule := match_bm_rule(r->>'task_name');
    END IF;

    -- Existing schedule row (for idempotency preview)
    IF NULLIF(r->>'bm_task_id', '') IS NOT NULL THEN
      SELECT state, manually_overridden_at, scheduled_for_date, assignee_id
        INTO existing
      FROM bm_task_schedule
      WHERE bm_task_id = r->>'bm_task_id';
    END IF;

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


-- ────────────────────────────────────────────────────────────
-- 5. import_bm_tasks — commit RPC
--
-- Payload shape:
--   { "rows": [ {
--       "bm_task_id":        "9398",           -- required
--       "bm_task_name":      "VAT Preparation Quarterly End 31/07/2025",
--       "client_reference":  "MADB01",
--       "client_name":       "Mademoiselle Beauty Ltd",  -- for entity_not_found flag detail
--       "assignee_name":     "Gary Paton",
--       "task_progress":     "No Progress",    -- BM status column
--       "latest_action_date":"2026-03-05",
--       "target_date":       "30/09/2024",
--       "deadline":          "07/10/2024"
--     }, ... ],
--     "seen_task_ids": ["9398","9451",...]   -- ALL task_ids in this CSV
--                                              (drives disappearance sweep)
--   }
--
-- Returns:
--   { scheduled:int, updated:int, overridden_skipped:int,
--     tasks_completed:int,
--     flags: {no_rule_match:int, entity_not_found:int,
--             completed_no_time:int, completed_under_expected:int,
--             deadline_moved:int},
--     errors:[{bm_task_id, message}],
--     skipped:[{bm_task_id, reason}] }
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.import_bm_tasks(run_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  row_input jsonb;
  errs jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;

  counter_scheduled          int := 0;
  counter_updated            int := 0;
  counter_overridden_skipped int := 0;
  counter_f_no_rule          int := 0;
  counter_f_entity           int := 0;
  counter_f_no_time          int := 0;
  counter_f_under            int := 0;
  counter_f_deadline         int := 0;
  counter_f_completed        int := 0;

  -- per-row working state
  bm_task_id_val       text;
  bm_task_name_val     text;
  entity_id_val        uuid;
  entity_name_val      text;
  assignee_id_val      uuid;
  assignee_name_raw    text;
  rule                 public.bm_scheduling_rules;
  deadline_d           date;
  target_d             date;
  latest_action_d      date;
  scheduled_d          date;
  scheduled_hrs        numeric(5,2);
  existing             public.bm_task_schedule;
  actual_minutes       int;
  expected_hours       numeric(5,2);

  -- disappearance sweep
  seen_ids  text[];
  cancelled_row record;
BEGIN
  IF NOT (
    COALESCE(is_portal_admin(), false)
    OR COALESCE((SELECT can_import_data FROM staff_profiles WHERE id = auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'forbidden: can_import_data required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM import_log WHERE id = run_id AND status = 'running') THEN
    RAISE EXCEPTION 'import_log % not in running status', run_id;
  END IF;

  -- ── Per-row processing ──────────────────────────────────────
  FOR row_input IN SELECT * FROM jsonb_array_elements(payload->'rows')
  LOOP
    BEGIN
      bm_task_id_val    := NULLIF(row_input->>'bm_task_id', '');
      bm_task_name_val  := NULLIF(row_input->>'bm_task_name', '');
      assignee_name_raw := NULLIF(TRIM(row_input->>'assignee_name'), '');

      IF bm_task_id_val IS NULL OR bm_task_name_val IS NULL THEN
        skipped := skipped || jsonb_build_object(
          'bm_task_id', bm_task_id_val,
          'reason', 'missing bm_task_id or bm_task_name'
        );
        CONTINUE;
      END IF;

      -- Entity resolution — missing entities get flagged so manager
      -- sees a list of clients present in BM but not in Athena.
      entity_id_val := NULL; entity_name_val := NULL;
      IF NULLIF(row_input->>'client_reference', '') IS NOT NULL THEN
        SELECT id, name INTO entity_id_val, entity_name_val
        FROM entities WHERE bm_client_id = row_input->>'client_reference'
        LIMIT 1;
      END IF;
      IF entity_id_val IS NULL THEN
        INSERT INTO bm_reconciliation_flags
          (bm_task_id, flag_type, severity, import_id, details)
        VALUES (
          bm_task_id_val, 'entity_not_found', 'warn', run_id,
          jsonb_build_object(
            'client_reference', row_input->>'client_reference',
            'client_name',      row_input->>'client_name',
            'bm_task_name',     bm_task_name_val
          )
        );
        counter_f_entity := counter_f_entity + 1;
        CONTINUE;
      END IF;

      -- Assignee resolution (upserts alias row as side effect)
      assignee_id_val := resolve_bm_assignee(assignee_name_raw);

      -- Date parsing
      deadline_d       := parse_bm_date(row_input->>'deadline');
      target_d         := parse_bm_date(row_input->>'target_date');
      latest_action_d  := parse_bm_date(row_input->>'latest_action_date');

      -- Rule match
      rule := match_bm_rule(bm_task_name_val);

      -- No rule: record flag, no schedule row created
      IF rule.id IS NULL THEN
        INSERT INTO bm_reconciliation_flags
          (bm_task_id, flag_type, severity, import_id, details)
        VALUES (
          bm_task_id_val, 'no_rule_match', 'warn', run_id,
          jsonb_build_object(
            'bm_task_name', bm_task_name_val,
            'entity_name',  entity_name_val,
            'assignee',     assignee_name_raw
          )
        );
        counter_f_no_rule := counter_f_no_rule + 1;
        CONTINUE;
      END IF;

      -- Compute scheduled slot from rule
      scheduled_d   := compute_bm_schedule_date(
                        rule.lead_time_days, rule.preferred_dow,
                        rule.preferred_week_of_month, deadline_d, target_d);
      scheduled_hrs := rule.standard_hours;

      -- Existing row?
      SELECT * INTO existing FROM bm_task_schedule
      WHERE bm_task_id = bm_task_id_val;

      IF existing.id IS NULL THEN
        -- INSERT path
        INSERT INTO bm_task_schedule (
          bm_task_id, entity_id, rule_id, bm_task_name, service,
          bm_deadline, bm_target_date, bm_status, bm_latest_action_date,
          assignee_id, bm_assignee_name,
          scheduled_for_date, scheduled_hours,
          state, last_import_id, last_seen_at
        ) VALUES (
          bm_task_id_val, entity_id_val, rule.id, bm_task_name_val, rule.service,
          deadline_d, target_d, NULLIF(row_input->>'task_progress',''), latest_action_d,
          COALESCE(assignee_id_val,
            CASE WHEN rule.assignee_source = 'rule_assignee' THEN rule.rule_assignee_id END),
          assignee_name_raw,
          scheduled_d, scheduled_hrs,
          'planned',
          run_id, now()
        );
        counter_scheduled := counter_scheduled + 1;
      ELSE
        -- UPDATE path
        -- Deadline moved + manual override = flag, don't change date
        IF existing.manually_overridden_at IS NOT NULL
           AND deadline_d IS DISTINCT FROM existing.bm_deadline THEN
          INSERT INTO bm_reconciliation_flags
            (bm_task_id, flag_type, severity, import_id, details)
          VALUES (
            bm_task_id_val, 'deadline_moved', 'warn', run_id,
            jsonb_build_object(
              'old_deadline', existing.bm_deadline,
              'new_deadline', deadline_d,
              'scheduled_for_date', existing.scheduled_for_date
            )
          );
          counter_f_deadline := counter_f_deadline + 1;
        END IF;

        UPDATE bm_task_schedule SET
          entity_id             = entity_id_val,
          rule_id               = rule.id,
          bm_task_name          = bm_task_name_val,
          service               = rule.service,
          bm_deadline           = deadline_d,
          bm_target_date        = target_d,
          bm_status             = NULLIF(row_input->>'task_progress',''),
          bm_latest_action_date = latest_action_d,
          assignee_id           = COALESCE(assignee_id_val,
                                    CASE WHEN rule.assignee_source = 'rule_assignee'
                                         THEN rule.rule_assignee_id END),
          bm_assignee_name      = assignee_name_raw,
          -- Only move the schedule if NOT manually overridden
          scheduled_for_date    = CASE
                                    WHEN manually_overridden_at IS NULL THEN scheduled_d
                                    ELSE scheduled_for_date
                                  END,
          scheduled_hours       = CASE
                                    WHEN manually_overridden_at IS NULL THEN scheduled_hrs
                                    ELSE scheduled_hours
                                  END,
          state                 = CASE
                                    WHEN state = 'cancelled' THEN 'planned'
                                    WHEN state = 'completed' THEN 'planned'  -- task reappeared
                                    ELSE state
                                  END,
          last_import_id        = run_id,
          last_seen_at          = now()
        WHERE bm_task_id = bm_task_id_val;

        IF existing.manually_overridden_at IS NOT NULL THEN
          counter_overridden_skipped := counter_overridden_skipped + 1;
        ELSE
          counter_updated := counter_updated + 1;
        END IF;
      END IF;

      -- NB: Bobby's operating model — the BM CSV export contains
      -- OPEN tasks only. Completion is detected by disappearance
      -- from the CSV, handled in the sweep block below.
      -- No per-row completion processing required.

    EXCEPTION WHEN OTHERS THEN
      errs := errs || jsonb_build_object(
        'bm_task_id', bm_task_id_val,
        'message', SQLERRM
      );
    END;
  END LOOP;

  -- ── Disappearance = completion sweep ───────────────────────
  -- Per Bobby's operating model: if a task was in our schedule
  -- but is not in today's CSV, BM has marked it completed.
  --
  -- For each disappeared task we:
  --   1. Sum logged time via timesheet_entries.source_task_id FK
  --      (staff link their entries to bm_task_schedule.id when
  --      logging progress against a planned block).
  --   2. If 0 hours → completed_no_time flag (prompt to log).
  --   3. If < scheduled_hours - 1h → completed_under_expected flag
  --      (prompt to double-check possibly-missing hours).
  --   4. Otherwise silently mark state='completed'.
  SELECT ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(payload->'seen_task_ids', '[]'::jsonb))
  ) INTO seen_ids;

  IF seen_ids IS NOT NULL AND array_length(seen_ids, 1) > 0 THEN
    FOR cancelled_row IN
      SELECT id, bm_task_id, bm_task_name, state, scheduled_for_date,
             scheduled_hours, entity_id, service
      FROM bm_task_schedule
      WHERE NOT (bm_task_id = ANY(seen_ids))
        AND state = 'planned'
    LOOP
      SELECT COALESCE(SUM(minutes), 0) INTO actual_minutes
      FROM timesheet_entries
      WHERE source_task_id = cancelled_row.id;

      expected_hours := cancelled_row.scheduled_hours;

      IF actual_minutes = 0 THEN
        INSERT INTO bm_reconciliation_flags
          (bm_task_id, flag_type, severity, import_id, details)
        VALUES (
          cancelled_row.bm_task_id, 'completed_no_time', 'warn', run_id,
          jsonb_build_object(
            'bm_task_name',       cancelled_row.bm_task_name,
            'expected_hours',     expected_hours,
            'scheduled_for_date', cancelled_row.scheduled_for_date,
            'entity_id',          cancelled_row.entity_id,
            'service',            cancelled_row.service
          )
        );
        counter_f_no_time := counter_f_no_time + 1;

      ELSIF (actual_minutes::numeric / 60) < (expected_hours - 1) THEN
        INSERT INTO bm_reconciliation_flags
          (bm_task_id, flag_type, severity, import_id, details)
        VALUES (
          cancelled_row.bm_task_id, 'completed_under_expected', 'warn', run_id,
          jsonb_build_object(
            'bm_task_name',    cancelled_row.bm_task_name,
            'expected_hours',  expected_hours,
            'actual_hours',    round(actual_minutes::numeric / 60, 2),
            'shortfall_hours', round(expected_hours - (actual_minutes::numeric / 60), 2),
            'entity_id',       cancelled_row.entity_id,
            'service',         cancelled_row.service
          )
        );
        counter_f_under := counter_f_under + 1;
      END IF;

      UPDATE bm_task_schedule
         SET state = 'completed',
             last_import_id = run_id,
             last_seen_at = now()
       WHERE id = cancelled_row.id;

      counter_f_completed := counter_f_completed + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'scheduled',           counter_scheduled,
    'updated',             counter_updated,
    'overridden_skipped',  counter_overridden_skipped,
    'tasks_completed',     counter_f_completed,
    'flags', jsonb_build_object(
      'no_rule_match',             counter_f_no_rule,
      'entity_not_found',          counter_f_entity,
      'completed_no_time',         counter_f_no_time,
      'completed_under_expected',  counter_f_under,
      'deadline_moved',            counter_f_deadline
    ),
    'errors',  errs,
    'skipped', skipped
  );
END $fn$;

GRANT EXECUTE ON FUNCTION public.import_bm_tasks(uuid, jsonb) TO authenticated;


-- ────────────────────────────────────────────────────────────
-- 6. bm_task_schedule_with_progress — read-model view
--
-- Planning calendar and timesheet grid render from this view.
-- As staff log time against a task (timesheet_entries.source_task_id
-- = bm_task_schedule.id), logged_hours rises and remaining_hours
-- shrinks. When a task spans multiple days, remaining_hours is
-- what needs to still be slotted in.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.bm_task_schedule_with_progress AS
SELECT
  s.*,
  COALESCE(ROUND(SUM(t.minutes)::numeric / 60, 2), 0) AS logged_hours,
  GREATEST(
    0,
    s.scheduled_hours - COALESCE(ROUND(SUM(t.minutes)::numeric / 60, 2), 0)
  ) AS remaining_hours
FROM public.bm_task_schedule s
LEFT JOIN public.timesheet_entries t
  ON t.source_task_id = s.id
GROUP BY s.id;

GRANT SELECT ON public.bm_task_schedule_with_progress TO authenticated;


COMMIT;

-- ══════════════════════════════════════════════════════════════
-- Verification queries
-- ══════════════════════════════════════════════════════════════
-- SELECT proname FROM pg_proc WHERE proname IN
--   ('match_bm_tasks','import_bm_tasks','match_bm_rule',
--    'resolve_bm_assignee','compute_bm_schedule_date','parse_bm_date');
--
-- SELECT constraint_name, check_clause FROM information_schema.check_constraints
-- WHERE constraint_name = 'bm_reconciliation_flags_flag_type_check';
