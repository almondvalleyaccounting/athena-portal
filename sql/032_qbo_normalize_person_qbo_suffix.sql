-- ══════════════════════════════════════════════════════════════
-- 032_qbo_normalize_person_qbo_suffix.sql
--
-- Bug: qbo_normalize_person did not strip the trailing "_<digits>"
-- QBO duplicate-suffix that qbo_canonical_corporate handles. Result:
-- a name like "Cairnpoint Limited_1728589264855" was passing the
-- corporate-token regex because the underscore is a regex
-- word-character — `\M` after "limited" didn't fire. The function
-- mis-classified as personal (surname = "limited_1728589264855"),
-- while the Athena-side clean "Cairnpoint Limited" correctly
-- classified as corporate. That tripped the mixed-branch penalty
-- (similarity × 0.3) and the real 1.0 match dropped to 0.173.
--
-- Fix: mirror the same strip at the top of qbo_normalize_person so
-- the corporate-token regex sees a clean boundary.
--
-- Applied live via MCP 2026-04-19.
-- ══════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION qbo_normalize_person(name text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  trimmed text; parts text[]; surname text; forenames text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  trimmed := lower(trim(name));
  trimmed := regexp_replace(trimmed, '_[0-9]+\s*$', '', 'g');
  trimmed := trim(trimmed);

  IF trimmed ~ '\m(ltd|limited|plc|llp|llc|inc|corp|corporation|company|group|services|holdings|properties|partners|partnership|associates|solutions|consulting|consultancy|enterprises|international|trust|foundation|estates|investments|developments|contracts|bank|studio|technologies|systems|media|design|logistics|property|capital|ventures|industries|nursery|clinic|school|academy|church|shop|store|cafe|gym|hall)\M' THEN
    RETURN NULL;
  END IF;

  IF trimmed LIKE '%,%' THEN
    parts := string_to_array(trimmed, ',');
    IF array_length(parts, 1) >= 2 THEN
      surname := trim(parts[1]);
      forenames := trim(array_to_string(parts[2:array_length(parts,1)], ' '));
      IF length(surname) > 0 THEN RETURN ARRAY[surname, forenames]; END IF;
    END IF;
  END IF;

  parts := regexp_split_to_array(trimmed, '\s+');
  IF array_length(parts, 1) = 2 THEN
    surname := parts[2];
    forenames := parts[1];
    IF length(surname) >= 2 THEN RETURN ARRAY[surname, forenames]; END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;
