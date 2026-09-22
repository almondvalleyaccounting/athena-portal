-- 283_hmrc_ct_payments.sql
--
-- Let the CT payments breakdown through, now that the scrape reads it.
--
-- HMRC offers four drill-downs under a Corporation Tax accounting period: Tax,
-- Interest, Less paid, Repayments/Reallocations. The scrape read two. The Less
-- paid one was never requested, so 822 periods carried GBP 9,920,494.92 with no
-- movements behind any of them, and nothing looked wrong because the period
-- summary's own total was always right -- only the detail was absent.
--
-- The scraper fix is 8f2a04d. This is the database catching up to it. Both
-- CHECK constraints refused the new rows on first publish, which is exactly what
-- they are for: the whole run rolled back rather than landing half-typed.
--
-- LJM Gas Glasgow's period to 31 Dec 2023 is the proof. HMRC itemises 23
-- movements; Athena held 8. The 15 that were missing are a monthly GBP 1,155.45
-- standing order -- a time-to-pay arrangement, invisible to us until now -- and
-- they sum to HMRC's stated GBP -17,087.57 exactly.

alter table hmrc.ct_transaction drop constraint if exists ct_transaction_line_check;
alter table hmrc.ct_transaction add constraint ct_transaction_line_check
  check (line = any (array['tax', 'interest', 'repayment', 'payments']));

alter table hmrc.ct_transaction drop constraint if exists ct_transaction_kind_check;
alter table hmrc.ct_transaction add constraint ct_transaction_kind_check
  check (kind = any (array['reallocation_ct', 'transfer_other_tax', 'repayment_cash',
                           'payment_cash', 'charge', 'other']));

-- `payment_cash` is the client paying HMRC. `repayment_cash` is HMRC paying the
-- client. They are opposite directions through the same account and the names
-- are one letter apart, which is why classifyTransaction matches the repayment
-- wording FIRST -- "Repayment by payable order" also contains the word payment.

-- The corporation-tax arm of this view read `line = 'repayment'` only, so CT was
-- the one head that could never emit a paid_by_client row. VAT, PAYE and Self
-- Assessment all do. MOVEMENT_META in ByTaxView.jsx has always had a pill for it.
create or replace view public.v_hmrc_money_movements
with (security_invoker = false) as
 WITH ct_txn AS (
         SELECT t.id, t.run_id, t.client_id, t.period_end, t.line, t.txn_date,
            t.description, t.amount, t.kind, t.direction, t.source_period_end,
            t.source_stated, cc.name AS client_name, cc.utr
           FROM hmrc.ct_transaction t
             JOIN v_hmrc_ct_scope s ON s.client_id = t.client_id AND s.run_id = t.run_id
             JOIN hmrc.ct_client cc ON cc.id = t.client_id
          WHERE t.line = ANY (ARRAY['repayment'::text, 'payments'::text])
        ), ct_classified AS (
         SELECT o.client_id, o.client_name, o.utr, o.period_end, o.txn_date,
            o.description, abs(o.amount) AS amount,
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
             LEFT JOIN ct_txn m ON m.client_id = o.client_id AND m.txn_date = o.txn_date
               AND abs(m.amount) = abs(o.amount) AND m.kind = 'reallocation_ct'::text
               AND m.source_period_end = o.period_end
               AND o.kind = 'transfer_other_tax'::text AND o.direction = 'out'::text
        )
 SELECT lk.entity_id, c.client_name AS hmrc_name, 'corporation-tax'::text AS tax,
    c.utr AS reference, c.txn_date, c.movement, c.description,
    c.period_end::text AS period, round(c.amount::numeric / 100.0, 2) AS amount
   FROM ct_classified c
     JOIN v_hmrc_ct_link lk ON lk.ct_client_id = c.client_id
  -- 'unclear' is INCLUDED. It was excluded, which silently dropped every CT
  -- movement whose wording the classifier did not recognise -- 17 on the
  -- repayment line today, plus 4 rows described "HMRC credit" worth
  -- GBP 30,338.32 that arrived with the payments breakdown. Dropping a movement
  -- because it is unfamiliar is how the Less paid page went unnoticed for a
  -- year. MOVEMENT_META in ByTaxView.jsx already has a pill for it, so an
  -- unrecognised row now shows as Unclear rather than as nothing.
  WHERE (c.movement = ANY (ARRAY['from_another_tax'::text, 'to_another_tax'::text,
                                 'cash_to_client'::text, 'internal_ct'::text,
                                 'paid_by_client'::text, 'unclear'::text]))
    AND hmrc_can_read()
UNION ALL
 SELECT vc.entity_id, vc.name AS hmrc_name, 'vat'::text AS tax, vc.vrn AS reference,
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
        CASE WHEN p.period_to IS NOT NULL THEN ' to '::text || p.period_to::text ELSE ''::text END AS period,
    round(p.amount::numeric / 100.0, 2) AS amount
   FROM hmrc.vat_payment p
     JOIN v_hmrc_vat_scope s ON s.client_id = p.client_id AND s.run_id = p.run_id
     JOIN hmrc.vat_client vc ON vc.id = p.client_id
  WHERE hmrc_can_read()
UNION ALL
 SELECT t.entity_id, t.hmrc_name, 'self-assessment'::text AS tax, t.utr AS reference,
    t.txn_date, t.movement, t.description,
    COALESCE(t.tax_year_ending, ''::text) AS period, t.amount
   FROM v_hmrc_sa_transactions t
UNION ALL
 SELECT c.entity_id, c.name AS hmrc_name, 'paye'::text AS tax, c.paye_ref AS reference,
    hmrc_safe_date(p.received_on) AS txn_date, 'paid_by_client'::text AS movement,
    COALESCE(p.allocated_to, 'Unallocated'::text) AS description,
    COALESCE(p.allocated_year, ''::text) AS period,
    round(p.amount::numeric / 100.0, 2) AS amount
   FROM hmrc.payment p
     JOIN hmrc.client c ON c.id = p.client_id
  WHERE p.run_id = ((SELECT max(p2.run_id) AS max FROM hmrc.payment p2 WHERE p2.client_id = p.client_id))
    AND COALESCE(p.received_on, ''::text) <> 'Total payment amount'::text
    AND hmrc_can_read();

revoke all on public.v_hmrc_money_movements from public, anon, authenticated;
grant select on public.v_hmrc_money_movements to authenticated, service_role;
