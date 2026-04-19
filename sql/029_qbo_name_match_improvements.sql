-- ══════════════════════════════════════════════════════════════
-- 029_qbo_name_match_improvements.sql
--
-- Name-aware scoring for suggest_entities_for_qbo. Personal names
-- get surname-first matching; corporate names keep full-string
-- similarity.
--
-- Problem being solved: "Chris Parkins" vs "Chris Paton" scored 58%
-- under raw trigram similarity on the full string, surfacing as a
-- plausible match. Surnames were never going to match, so the score
-- is meaningless. Worse: "Chris Parkins" vs "Christopher Parkins"
-- (the actual correct match after BM storing names as "Lastname,
-- Firstname") was penalised for word-order and forename length.
--
-- New logic:
--  - qbo_normalize_person(name): returns ARRAY[surname, forenames]
--    if the name looks personal (has a comma, or 2-3 tokens with
--    no corporate suffix). Else NULL.
--  - qbo_canonical_surname(name): strips apostrophes/hyphens/spaces
--    and normalises Mac/Mc prefixes so MacFarlane = McFarlane.
--  - qbo_name_match_score(query, candidate):
--      both personal → surname_sim * 0.65 + forename_sim * 0.35,
--        but surname_sim < 0.75 caps the score well below threshold.
--        Forename gets a prefix boost (Chris → Christopher → 0.92).
--      mixed personal/corporate → similarity * 0.5 (discouraged).
--      both corporate → raw full-string similarity (as before).
--
-- suggest_entities_for_qbo uses the new scorer with a 0.2 pre-filter
-- via the GIN trigram index, then re-ranks.
--
-- Verified against real pairs 2026-04-19:
--   Chris Parkins ↔ Paton, Chris              → 0.033  (surname kill)
--   Chris Parkins ↔ Parkins, Christopher      → 0.963  (prefix boost)
--   Chris Parkins ↔ Parkins, Chris            → 1.000
--   Grant MacFarlane ↔ Grant McFarlane        → 1.000  (Mac/Mc canonical)
--   John O'Donnell ↔ ODonnell, John           → 1.000
--   Ben Agnew ↔ Agnew, Ben                    → 1.000
--   Barry McKenzie ↔ McKenzie, Gordon         → 0.260  (forename dampener)
--   John Smith ↔ Jon Smith                    → 0.569
--   101 Business Solutions Ltd ↔ … Limited    → 0.706
--   Chris Parkins ↔ ACME Parkins Ltd          → 0.174
-- ══════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION qbo_normalize_person(name text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  trimmed text;
  parts text[];
  surname text;
  forenames text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  trimmed := lower(trim(name));

  IF trimmed ~ '\m(ltd|limited|plc|llp|llc|inc|corp|corporation|company|group|services|holdings|properties|partners|partnership|associates|solutions|consulting|consultancy|enterprises|international|trust|foundation|estates|investments|developments|contracts|bank|studio|technologies|systems|media|design|logistics|property|capital|ventures|industries)\M' THEN
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
  IF array_length(parts, 1) BETWEEN 2 AND 3 THEN
    surname := parts[array_length(parts, 1)];
    forenames := array_to_string(parts[1:array_length(parts,1)-1], ' ');
    IF length(surname) >= 2 THEN RETURN ARRAY[surname, forenames]; END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION qbo_canonical_surname(name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  s := lower(trim(name));
  s := regexp_replace(s, '[''\-\s]', '', 'g');
  IF s LIKE 'mac%' AND length(s) > 4 THEN
    s := substring(s FROM 4);
  ELSIF s LIKE 'mc%' AND length(s) > 3 THEN
    s := substring(s FROM 3);
  END IF;
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION qbo_name_match_score(query text, candidate text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  qp text[]; cp text[];
  surname_sim numeric; forename_sim numeric; prefix_boost numeric;
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

    -- Weighted geometric mean — both components must contribute.
    -- Barry vs Gordon McKenzie: POWER(1.0, 0.55) * POWER(0.1, 0.45) ≈ 0.26
    -- (weighted-sum 0.65/0.35 previously gave 0.685, which surfaced
    -- completely different people as strong matches).
    RETURN ROUND(POWER(surname_sim, 0.55) * POWER(forename_sim, 0.45), 3);
  END IF;

  IF (qp IS NULL) != (cp IS NULL) THEN
    RETURN ROUND(similarity(lower(query), lower(candidate))::numeric * 0.5, 3);
  END IF;

  RETURN ROUND(similarity(lower(query), lower(candidate))::numeric, 3);
END;
$$;

CREATE OR REPLACE FUNCTION suggest_entities_for_qbo(
  customers jsonb,
  min_score numeric DEFAULT 0.3,
  limit_n int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  c jsonb; qbo_id text; name_query text; sugg jsonb;
BEGIN
  IF NOT is_active_staff() THEN
    RAISE EXCEPTION 'forbidden: active staff only';
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(customers)
  LOOP
    qbo_id := c->>'qbo_customer_id';
    name_query := NULLIF(c->>'name', '');

    IF name_query IS NULL THEN
      result := result || jsonb_build_object('qbo_customer_id', qbo_id, 'suggestions', '[]'::jsonb);
      CONTINUE;
    END IF;

    -- Pre-filter uses the GIN trigram index (loose 0.2), then re-rank
    -- with the smarter name-aware scorer.
    WITH ranked AS (
      SELECT
        e.id AS entity_id,
        e.name AS entity_name,
        e.entity_status,
        qbo_name_match_score(name_query, e.name) AS score
      FROM entities e
      WHERE similarity(lower(e.name), lower(name_query)) >= 0.2
      ORDER BY qbo_name_match_score(name_query, e.name) DESC
      LIMIT 20
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.score DESC), '[]'::jsonb)
      INTO sugg
    FROM (
      SELECT * FROM ranked WHERE score >= min_score LIMIT limit_n
    ) r;

    result := result || jsonb_build_object('qbo_customer_id', qbo_id, 'suggestions', sugg);
  END LOOP;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION suggest_entities_for_qbo(jsonb, numeric, int) TO authenticated;

COMMIT;
