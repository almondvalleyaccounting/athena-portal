-- 298: /hmrc/all timed out ("canceling statement due to statement timeout").
--
-- v_hmrc_client_totals left-joins an aggregate of v_hmrc_money_movements, whose
-- corporation-tax arm joins v_hmrc_ct_link. Two faults compounded:
--
-- 1. v_hmrc_ct_link cost 2.2s for 225 rows. norm_c was inlined, so a CT client's
--    normalised name (two regexp_replace calls) was recomputed for every one of
--    the ~680 entities it was compared against, in three laterals plus the
--    prefix-uniqueness count. MATERIALIZED computes each key once. ~20ms now.
--
-- 2. The planner estimates ct_txn at ~41 rows (the v_hmrc_ct_scope join is badly
--    mis-estimated; it is ~2,900), so it put v_hmrc_ct_link on the inner side of
--    a nested loop and re-ran it once per CT transaction: ~2,900 x 2.2s. The link
--    is now read once into a MATERIALIZED CTE and hash-joined.
--
-- Nothing else changes. Same columns, same predicates, same hmrc_can_read()
-- guards (both views stay definer views over the private hmrc schema), and
-- CREATE OR REPLACE keeps the existing ACLs. Verified as a staff user: every
-- dependent view (ct_link, client_tax_summary, money_movements, client_totals,
-- client_position, ct_periods, scrape_health) hashes identically before/after.

create or replace view public.v_hmrc_ct_link as
 WITH norm_e AS MATERIALIZED (
         SELECT entities.id,
            entities.name,
            entities.entity_status,
            NULLIF(regexp_replace(COALESCE(entities.company_number, ''::text), '[^0-9A-Za-z]'::text, ''::text, 'g'::text), ''::text) AS cn,
            regexp_replace(regexp_replace(lower(entities.name), '\s*(limited|ltd|llp|plc)\.?$'::text, ''::text), '[^a-z0-9]'::text, ''::text, 'g'::text) AS k
           FROM entities
        ), norm_c AS MATERIALIZED (
         SELECT c_1.id,
            c_1.utr,
            c_1.name,
            c_1.company_number,
            c_1.your_reference,
            c_1.entity_id,
            c_1.entity_name,
            c_1.link_method,
            c_1.first_seen,
            c_1.last_seen,
            NULLIF(regexp_replace(COALESCE(c_1.company_number, ''::text), '[^0-9A-Za-z]'::text, ''::text, 'g'::text), ''::text) AS cn,
            regexp_replace(regexp_replace(lower(c_1.name), '\s*(limited|ltd|llp|plc)\.?$'::text, ''::text), '[^a-z0-9]'::text, ''::text, 'g'::text) AS k
           FROM hmrc.ct_client c_1
        )
 SELECT c.id AS ct_client_id,
    c.utr,
    c.name AS hmrc_name,
    c.company_number AS hmrc_company_number,
    c.your_reference,
    COALESCE(bycn.id, byname.id, bypre.id) AS entity_id,
    COALESCE(bycn.name, byname.name, bypre.name) AS entity_name,
    COALESCE(bycn.entity_status, byname.entity_status, bypre.entity_status)::text AS entity_status,
        CASE
            WHEN bycn.id IS NOT NULL AND byname.id IS NOT NULL AND bycn.id <> byname.id THEN 'conflict'::text
            WHEN bycn.id IS NOT NULL THEN 'company_number'::text
            WHEN byname.id IS NOT NULL THEN 'name'::text
            WHEN bypre.id IS NOT NULL THEN 'prefix'::text
            ELSE 'unmatched'::text
        END AS link_method
   FROM norm_c c
     LEFT JOIN LATERAL ( SELECT e.id,
            e.name,
            e.entity_status,
            e.cn,
            e.k
           FROM norm_e e
          WHERE e.cn IS NOT NULL AND e.cn = c.cn
         LIMIT 1) bycn ON true
     LEFT JOIN LATERAL ( SELECT e.id,
            e.name,
            e.entity_status,
            e.cn,
            e.k
           FROM norm_e e
          WHERE e.k = c.k AND e.k <> ''::text
          ORDER BY (e.entity_status::text = 'active'::text) DESC, e.name
         LIMIT 1) byname ON true
     LEFT JOIN LATERAL ( SELECT e.id,
            e.name,
            e.entity_status,
            e.cn,
            e.k
           FROM norm_e e
          WHERE length(c.k) >= 12 AND length(e.k) >= 12 AND (e.k ~~ (c.k || '%'::text) OR c.k ~~ (e.k || '%'::text)) AND (( SELECT count(*) AS count
                   FROM norm_e e2
                  WHERE length(e2.k) >= 12 AND (e2.k ~~ (c.k || '%'::text) OR c.k ~~ (e2.k || '%'::text)))) = 1
         LIMIT 1) bypre ON true
  WHERE hmrc_can_read();

create or replace view public.v_hmrc_money_movements
with (security_invoker = false) as
 WITH ct_lk AS MATERIALIZED (
         SELECT l.ct_client_id,
            l.entity_id
           FROM v_hmrc_ct_link l
        ), ct_txn AS (
         SELECT t.id,
            t.run_id,
            t.client_id,
            t.period_end,
            t.line,
            t.txn_date,
            t.description,
            t.amount,
            t.kind,
            t.direction,
            t.source_period_end,
            t.source_stated,
            cc.name AS client_name,
            cc.utr
           FROM hmrc.ct_transaction t
             JOIN v_hmrc_ct_scope s ON s.client_id = t.client_id AND s.run_id = t.run_id
             JOIN hmrc.ct_client cc ON cc.id = t.client_id
          WHERE t.line = ANY (ARRAY['repayment'::text, 'payments'::text])
        ), ct_classified AS (
         SELECT o.client_id,
            o.client_name,
            o.utr,
            o.period_end,
            o.txn_date,
            o.description,
            abs(o.amount) AS amount,
                CASE
                    WHEN o.kind = 'payment_cash'::text THEN 'paid_by_client'::text
                    WHEN o.kind = 'repayment_cash'::text THEN 'cash_to_client'::text
                    WHEN o.kind = 'reallocation_ct'::text THEN 'internal_ct'::text
                    WHEN o.kind = 'transfer_other_tax'::text AND m.id IS NOT NULL THEN 'internal_ct'::text
                    WHEN o.kind = 'transfer_other_tax'::text AND o.direction = 'in'::text THEN 'from_another_tax'::text
                    WHEN o.kind = 'transfer_other_tax'::text AND o.direction = 'out'::text THEN 'to_another_tax'::text
                    ELSE 'unclear'::text
                END AS movement
           FROM ct_txn o
             LEFT JOIN ct_txn m ON m.client_id = o.client_id AND m.txn_date = o.txn_date AND abs(m.amount) = abs(o.amount) AND m.kind = 'reallocation_ct'::text AND m.source_period_end = o.period_end AND o.kind = 'transfer_other_tax'::text AND o.direction = 'out'::text
        )
 SELECT lk.entity_id,
    c.client_name AS hmrc_name,
    'corporation-tax'::text AS tax,
    c.utr AS reference,
    c.txn_date,
    c.movement,
    c.description,
    c.period_end::text AS period,
    round(c.amount::numeric / 100.0, 2) AS amount
   FROM ct_classified c
     JOIN ct_lk lk ON lk.ct_client_id = c.client_id
  WHERE (c.movement = ANY (ARRAY['from_another_tax'::text, 'to_another_tax'::text, 'cash_to_client'::text, 'internal_ct'::text, 'paid_by_client'::text, 'unclear'::text])) AND hmrc_can_read()
UNION ALL
 SELECT vc.entity_id,
    vc.name AS hmrc_name,
    'vat'::text AS tax,
    vc.vrn AS reference,
    p.txn_date,
        CASE
            WHEN p.kind = ANY (ARRAY['repayment'::text, 'repayment_interest'::text]) THEN 'cash_to_client'::text
            WHEN p.kind = 'transfer'::text AND p.direction = 'from_hmrc'::text THEN 'from_another_tax'::text
            WHEN p.kind = 'transfer'::text THEN 'to_another_tax'::text
            WHEN p.direction = 'to_hmrc'::text THEN 'paid_by_client'::text
            ELSE 'other'::text
        END AS movement,
    p.description,
    COALESCE(p.period_from::text, ''::text) ||
        CASE
            WHEN p.period_to IS NOT NULL THEN ' to '::text || p.period_to::text
            ELSE ''::text
        END AS period,
    round(p.amount::numeric / 100.0, 2) AS amount
   FROM hmrc.vat_payment p
     JOIN v_hmrc_vat_scope s ON s.client_id = p.client_id AND s.run_id = p.run_id
     JOIN hmrc.vat_client vc ON vc.id = p.client_id
  WHERE hmrc_can_read()
UNION ALL
 SELECT t.entity_id,
    t.hmrc_name,
    'self-assessment'::text AS tax,
    t.utr AS reference,
    t.txn_date,
    t.movement,
    t.description,
    COALESCE(t.tax_year_ending, ''::text) AS period,
    t.amount
   FROM v_hmrc_sa_transactions t
UNION ALL
 SELECT c.entity_id,
    c.name AS hmrc_name,
    'paye'::text AS tax,
    c.paye_ref AS reference,
    hmrc_safe_date(p.received_on) AS txn_date,
    'paid_by_client'::text AS movement,
    COALESCE(p.allocated_to, 'Unallocated'::text) AS description,
    COALESCE(p.allocated_year, ''::text) AS period,
    round(p.amount::numeric / 100.0, 2) AS amount
   FROM hmrc.payment p
     JOIN hmrc.client c ON c.id = p.client_id
  WHERE p.run_id = (( SELECT max(p2.run_id) AS max
           FROM hmrc.payment p2
          WHERE p2.client_id = p.client_id)) AND COALESCE(p.received_on, ''::text) <> 'Total payment amount'::text AND hmrc_can_read();
