-- 080_email_reconciliation_view.sql
-- Reconciliation between BrightManager contact email (people.email, 1:1 per
-- customer) and QuickBooks billing emails (qbo_customer_mappings.qbo_email,
-- 1:many). Ownership: contact email = BM, billing email = QBO. Athena reads
-- both and flags gaps / differences.
--
-- status:
--   ok        — the BM contact email is present in the QBO billing list
--   mismatch  — both sides have emails but the BM email isn't in the QBO list
--   gap_qbo   — BM has a contact email, QBO has no billing email
--   gap_bm    — QBO has billing email(s), no BM contact email on file
--   gap_both  — neither side has an email

CREATE OR REPLACE VIEW v_email_reconciliation AS
WITH bm AS (
  SELECT DISTINCT ON (ep.entity_id)
         ep.entity_id,
         lower(btrim(p.email)) AS bm_email
  FROM entity_people ep
  JOIN people p ON p.id = ep.person_id
  WHERE ep.is_primary_contact = true
    AND ep.source = 'brightmanager'
    AND p.email IS NOT NULL AND btrim(p.email) <> ''
  ORDER BY ep.entity_id, p.updated_at DESC NULLS LAST
),
qbo AS (
  SELECT m.entity_id,
         array_agg(DISTINCT lower(btrim(tok))) FILTER (WHERE btrim(tok) <> '') AS emails
  FROM qbo_customer_mappings m
  CROSS JOIN LATERAL regexp_split_to_table(COALESCE(m.qbo_email, ''), '[,;]+') AS tok
  WHERE m.entity_id IS NOT NULL
  GROUP BY m.entity_id
)
SELECT
  ent.id            AS entity_id,
  ent.name,
  ent.qbo_customer_id,
  bm.bm_email       AS bm_contact_email,
  COALESCE(qbo.emails, ARRAY[]::text[]) AS qbo_billing_emails,
  CASE
    WHEN bm.bm_email IS NULL AND (qbo.emails IS NULL OR cardinality(qbo.emails) = 0) THEN 'gap_both'
    WHEN bm.bm_email IS NULL                                                          THEN 'gap_bm'
    WHEN qbo.emails IS NULL OR cardinality(qbo.emails) = 0                            THEN 'gap_qbo'
    WHEN bm.bm_email = ANY(qbo.emails)                                                THEN 'ok'
    ELSE 'mismatch'
  END AS status
FROM entities ent
LEFT JOIN bm  ON bm.entity_id  = ent.id
LEFT JOIN qbo ON qbo.entity_id = ent.id
WHERE bm.bm_email IS NOT NULL
   OR qbo.emails IS NOT NULL
   OR ent.qbo_customer_id IS NOT NULL;
