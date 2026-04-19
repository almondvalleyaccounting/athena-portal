-- ══════════════════════════════════════════════════════════════
-- 030_qbo_corporate_canonical.sql
--
-- Two fixes for corporate-name false positives surfacing in the QBO
-- mapping UI (Big Hooks Ltd ↔ Big Al Events Ltd scoring 33%, etc).
--
-- 1. qbo_canonical_corporate(name): strips Ltd/Limited/Plc/LLP/
--    Services/Holdings/the/and/etc., punctuation, collapses whitespace.
--    So "Big Hooks Ltd" normalises to "big hooks" and shared
--    boilerplate doesn't inflate trigram similarity.
--
-- 2. qbo_name_match_score both-corporate branch now compares
--    canonical forms AND takes the max of space-preserved vs
--    space-stripped similarity. "Puddle Duck Nursery" ↔ "Puddleduck
--    Nursery Ltd" returns 1.0 via the space-stripped path.
--
-- 3. qbo_normalize_person tightened: without a comma, require exactly
--    2 tokens. 3-token cases without commas are usually businesses
--    that happen to lack a formal suffix ("Puddle Duck Nursery",
--    "Big Al Events"). Multi-word personal names still handled via
--    the comma form which BM uses.
--
-- Applied live via MCP 2026-04-19.
--
-- Verified pairs:
--   Big Hooks Ltd ↔ Big Al Events Ltd           → 0.200  (was 0.330)
--   Bistro 6 Ltd ↔ Qm2 Ltd                      → 0.000  (was 0.380)
--   BMK Plumbing ↔ Gillies Heating              → 0.296  (was 0.410)
--   Barry McKenzie ↔ McKenzie, Gordon           → 0.260  (was 0.685)
--   Puddle Duck Nursery ↔ Puddleduck Nursery    → 1.000  (preserved)
--   101 Business Solutions Ltd ↔ Limited        → 1.000  (was 0.706)
--   Foursite Inc ↔ Foursite Inc Ltd             → 1.000
--   Chris Parkins ↔ Parkins, Christopher        → 0.963
--   Grant MacFarlane ↔ Grant McFarlane          → 1.000
-- ══════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION qbo_canonical_corporate(name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  s := lower(name);
  s := regexp_replace(s, '&', ' and ', 'g');
  s := regexp_replace(s, '[\.,/\\()''"]', ' ', 'g');
  s := regexp_replace(
    s,
    '\m(ltd|limited|plc|llp|llc|inc|corp|corporation|company|co|group|services|holdings|holding|properties|property|partners|partnership|associates|solutions|consulting|consultancy|enterprises|enterprise|international|trust|foundation|estates|investments|developments|contracts|studio|technologies|systems|media|design|logistics|capital|ventures|industries|the|and|of)\M',
    ' ', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  RETURN trim(s);
END;
$$;

CREATE OR REPLACE FUNCTION qbo_normalize_person(name text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  trimmed text; parts text[]; surname text; forenames text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  trimmed := lower(trim(name));

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

CREATE OR REPLACE FUNCTION qbo_name_match_score(query text, candidate text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  qp text[]; cp text[];
  surname_sim numeric; forename_sim numeric; prefix_boost numeric;
  qc text; cc text; corp_sim numeric;
BEGIN
  qp := qbo_normalize_person(query);
  cp := qbo_normalize_person(candidate);

  IF qp IS NOT NULL AND cp IS NOT NULL THEN
    IF qbo_canonical_surname(qp[1]) = qbo_canonical_surname(cp[1]) THEN
      surname_sim := 1.0;
    ELSE
      surname_sim := similarity(qp[1], cp[1])::numeric;
    END IF;

    IF surname_sim < 0.75 THEN
      RETURN ROUND(surname_sim * 0.2, 3);
    END IF;

    forename_sim := similarity(qp[2], cp[2])::numeric;
    prefix_boost := 0;
    IF length(qp[2]) >= 3 AND length(cp[2]) >= 3 AND
       (cp[2] LIKE qp[2] || '%' OR qp[2] LIKE cp[2] || '%') THEN
      prefix_boost := 0.92;
    END IF;
    forename_sim := GREATEST(forename_sim, prefix_boost, 0.05::numeric);

    RETURN ROUND(POWER(surname_sim, 0.55) * POWER(forename_sim, 0.45), 3);
  END IF;

  IF (qp IS NULL) != (cp IS NULL) THEN
    RETURN ROUND(similarity(lower(query), lower(candidate))::numeric * 0.3, 3);
  END IF;

  qc := qbo_canonical_corporate(query);
  cc := qbo_canonical_corporate(candidate);

  IF length(COALESCE(qc, '')) = 0 OR length(COALESCE(cc, '')) = 0 THEN
    RETURN ROUND(similarity(lower(query), lower(candidate))::numeric, 3);
  END IF;

  corp_sim := GREATEST(
    similarity(qc, cc)::numeric,
    similarity(regexp_replace(qc, '\s+', '', 'g'), regexp_replace(cc, '\s+', '', 'g'))::numeric
  );
  RETURN ROUND(corp_sim, 3);
END;
$$;

COMMIT;
