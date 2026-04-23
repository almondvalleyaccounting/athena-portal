-- ══════════════════════════════════════════════════════════════
-- 040_bm_alias_case_cleanup.sql  (data migration, not DDL)
--
-- Fix duplicate bm_staff_aliases rows caused by case-insensitive
-- lookup + case-sensitive writes.
--
-- Bug: the import-side resolver (sql/035, ensure_bm_alias) seeds
-- rows with LOWER(TRIM(name)) as the key, but ImportView.jsx wrote
-- with the raw title-case name. Primary key is case-sensitive, so
-- every staff member had TWO rows — a lowercase unmapped one (what
-- the import looks up) and a title-case mapped one (what the UI
-- saved). Mappings never stuck.
--
-- Cleanup: for each (title-case, lowercase) pair, copy any useful
-- state (staff_profile_id, active, notes) from the title-case row
-- onto the lowercase row, then delete the title-case duplicate.
--
-- UI fix already shipped in the same commit: ImportView now writes
-- LOWER(TRIM(...)) + a separate display_name, matching the import
-- convention.
-- ══════════════════════════════════════════════════════════════

BEGIN;

-- Carry staff_profile_id, active, notes from title-case onto the
-- lowercase row if the lowercase row is missing them.
UPDATE public.bm_staff_aliases l
   SET staff_profile_id = COALESCE(l.staff_profile_id, t.staff_profile_id),
       active           = COALESCE(l.active, t.active),
       notes            = COALESCE(l.notes, t.notes),
       display_name     = COALESCE(l.display_name, t.display_name),
       updated_at       = now()
  FROM public.bm_staff_aliases t
 WHERE l.bm_assignee_name = LOWER(t.bm_assignee_name)
   AND l.bm_assignee_name <> t.bm_assignee_name;

-- Delete the title-case duplicates (the ones that have a lowercase sibling).
DELETE FROM public.bm_staff_aliases t
 WHERE EXISTS (
   SELECT 1 FROM public.bm_staff_aliases l
    WHERE l.bm_assignee_name = LOWER(t.bm_assignee_name)
      AND l.bm_assignee_name <> t.bm_assignee_name
 );

-- Defensive: any remaining rows whose key isn't already lowercase
-- (e.g. a lone title-case row with no lowercase sibling) get
-- normalised in place. Using a CTE to avoid pk-conflict mid-update.
WITH to_rename AS (
  SELECT bm_assignee_name AS old_key, LOWER(bm_assignee_name) AS new_key
    FROM public.bm_staff_aliases
   WHERE bm_assignee_name <> LOWER(bm_assignee_name)
)
UPDATE public.bm_staff_aliases a
   SET bm_assignee_name = r.new_key,
       display_name     = COALESCE(a.display_name, r.old_key),
       updated_at       = now()
  FROM to_rename r
 WHERE a.bm_assignee_name = r.old_key;

COMMIT;
