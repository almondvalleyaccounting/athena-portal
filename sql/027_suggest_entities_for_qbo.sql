-- ══════════════════════════════════════════════════════════════
-- 027_suggest_entities_for_qbo.sql
--
-- Top-N entity suggestions per QBO customer name, pg_trgm similarity.
-- Used by the QBO Mapping UI to pre-fill match candidates for unmapped
-- rows. Returns [{qbo_customer_id, suggestions: [...]}] so the UI
-- makes one call for every unmapped row.
--
-- Applied live via MCP 2026-04-19.
-- ══════════════════════════════════════════════════════════════

BEGIN;

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
  c jsonb;
  qbo_id text;
  name_query text;
  sugg jsonb;
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

    SELECT COALESCE(jsonb_agg(row_to_json(s)), '[]'::jsonb) INTO sugg
    FROM (
      SELECT
        e.id AS entity_id,
        e.name AS entity_name,
        e.entity_status,
        ROUND(similarity(lower(e.name), lower(name_query))::numeric, 3) AS score
      FROM entities e
      WHERE similarity(lower(e.name), lower(name_query)) >= min_score
      ORDER BY score DESC
      LIMIT limit_n
    ) s;

    result := result || jsonb_build_object('qbo_customer_id', qbo_id, 'suggestions', sugg);
  END LOOP;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION suggest_entities_for_qbo(jsonb, numeric, int) TO authenticated;

COMMIT;
