-- ══════════════════════════════════════════════════════════════
-- 031_qbo_tighten_matching.sql
--
-- Round 2 of corporate-match tightening, driven by real 2026-04-19
-- review: 38-50% false positives still surfacing on shared industry
-- or geographic tokens (Plumbing, Heating, Financial, Tree, Agency,
-- Renovations, Scotland, etc.).
--
-- Four changes:
--
-- 1. Expand qbo_canonical_corporate stop-word list:
--    - Industry descriptors: plumbing, heating, financial, finance,
--      tree(s), agency, letting(s), builder(s), renovations, extensions,
--      landscapes, landscape, construction, joinery, electrical,
--      mechanical, engineering, roofing, estate(s), management
--    - Geographic: scotland, scottish, uk, united, kingdom, british,
--      english, welsh, wales, ireland, glasgow, edinburgh, london,
--      manchester, aberdeen, dundee, stirling
--
-- 2. Strip QBO duplicate-suffix artefacts: trailing `_<digits>` as in
--    "Cedarwood Developments Scotland Ltd_1691750403706". Those are
--    QBO auto-generated on customer rename/duplication and destroy
--    similarity against the underlying name.
--
-- 3. Weak-canonical penalty: if either side's canonical form collapses
--    to ≤1 token of ≤6 characters, multiply the score by 0.4. Two
--    unrelated businesses often share one common noun ("Castle",
--    "Cedar", "Smith") — that alone isn't signal enough to surface as
--    a match. Preserves cases with distinctive longer stems
--    (Puddleduck 10 chars, Cedarwood 9 chars, 101 Business 2 tokens).
--
-- 4. Raise default min_score on suggest_entities_for_qbo from 0.3 →
--    0.5. The 30-50% band was almost entirely noise. Caller can still
--    override for exploratory searches.
--
-- Verified pairs after changes:
--   Castle Letting Agency ↔ Castle Estate Agency  → 0.40  (filtered)
--   Cedar Tree Property ↔ JL Tree Services        → 0.00
--   BMK Plumbing ↔ Saf Plumbing & Heating         → 0.00  (was 0.65)
--   Av8 Accounting ↔ Almond Valley Accounting     → 0.41  (filtered)
--   Cedarwood Dev Scotland Ltd_169... ↔ Ltd       → 1.00  (suffix stripped)
--   Puddle Duck Nursery ↔ Puddleduck Nursery Ltd  → 1.00  (preserved)
--   101 Business Solutions Ltd ↔ Limited          → 1.00
--   Foursite Inc ↔ Foursite Inc Ltd               → 1.00
--   Barry McKenzie ↔ McKenzie, Gordon             → 0.260
--   Chris Parkins ↔ Parkins, Christopher          → 0.963
--   Grant MacFarlane ↔ Grant McFarlane            → 1.000
--   Darryn Robb ↔ Robb, Daryn                     → 0.809
--
-- Applied live via MCP 2026-04-19.
-- ══════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION qbo_canonical_corporate(name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  s := lower(name);
  s := regexp_replace(s, '_[0-9]+\s*$', '', 'g');
  s := regexp_replace(s, '&', ' and ', 'g');
  s := regexp_replace(s, '[\.,/\\()''"]', ' ', 'g');
  s := regexp_replace(
    s,
    '\m(' ||
    'ltd|limited|plc|llp|llc|inc|corp|corporation|company|co|group|' ||
    'services|service|holdings|holding|properties|property|partners|partnership|' ||
    'associates|solutions|consulting|consultancy|enterprises|enterprise|' ||
    'international|trust|foundation|estates|estate|investments|developments|' ||
    'contracts|contracting|studio|technologies|systems|media|design|logistics|' ||
    'capital|ventures|industries|management|' ||
    'plumbing|heating|financial|finance|tree|trees|agency|letting|lettings|' ||
    'builder|builders|renovations|extensions|landscapes|landscape|' ||
    'construction|joinery|electrical|mechanical|engineering|roofing|' ||
    'scotland|scottish|uk|united|kingdom|british|english|welsh|wales|ireland|' ||
    'glasgow|edinburgh|london|manchester|aberdeen|dundee|stirling|' ||
    'the|and|of' ||
    ')\M',
    ' ', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  RETURN trim(s);
END;
$$;

CREATE OR REPLACE FUNCTION qbo_name_match_score(query text, candidate text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  qp text[]; cp text[];
  surname_sim numeric; forename_sim numeric; prefix_boost numeric;
  qc text; cc text; corp_sim numeric;
  q_nosp text; c_nosp text;
  q_tokens int; c_tokens int; weak boolean;
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

  q_nosp := regexp_replace(qc, '\s+', '', 'g');
  c_nosp := regexp_replace(cc, '\s+', '', 'g');
  corp_sim := GREATEST(
    similarity(qc, cc)::numeric,
    similarity(q_nosp, c_nosp)::numeric
  );

  q_tokens := array_length(string_to_array(qc, ' '), 1);
  c_tokens := array_length(string_to_array(cc, ' '), 1);
  weak := (q_tokens <= 1 AND length(q_nosp) <= 6)
       OR (c_tokens <= 1 AND length(c_nosp) <= 6);
  IF weak THEN
    corp_sim := corp_sim * 0.4;
  END IF;

  RETURN ROUND(corp_sim, 3);
END;
$$;

CREATE OR REPLACE FUNCTION suggest_entities_for_qbo(
  customers jsonb,
  min_score numeric DEFAULT 0.5,
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
