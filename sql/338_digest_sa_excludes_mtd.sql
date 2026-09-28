-- ============================================================
-- 338 — MTD quarterly filings are not self assessment returns
--
-- BM files "MTD Quarterly Filing Submission …" under Personal Tax, and the
-- sa CTE takes any Personal Tax "…Submission…" task, so the six MTD updates
-- due 7 Nov 2026 were counted in the digest's and home dashboard's SA
-- figure (sa_next_jan, sa_overdue). They are a different filing (Bobby,
-- 2026-09-28). SA800 partnership returns stay in, deliberately.
--
-- Only the sa CTE changes; everything else is sql/134 verbatim.
-- ============================================================

create or replace view public.v_deadline_buckets
with (security_invoker = true) as
 WITH base AS (
         SELECT b.service,
            b.bm_task_name,
            b.bm_deadline
           FROM bm_task_schedule b
             LEFT JOIN entities e ON e.id = b.entity_id
          WHERE b.state = 'planned'::text AND b.excluded_at IS NULL AND b.bm_deadline IS NOT NULL AND (COALESCE(e.entity_status::text, 'active'::text) <> ALL (ARRAY['nlac'::text, 'archived'::text]))
        ), ch AS (
         SELECT base.service,
            base.bm_task_name,
            base.bm_deadline
           FROM base
          WHERE base.bm_task_name ~~* 'Companies House Submission%'::text
        ), sa AS (
         SELECT base.service,
            base.bm_task_name,
            base.bm_deadline
           FROM base
          WHERE (base.bm_task_name ~~* 'Self Assessment%'::text OR base.bm_task_name ~~* 'SA800%'::text OR base.service = 'Personal Tax'::text)
            AND base.bm_task_name ~~* '%Submission%'::text
            AND base.bm_task_name !~* '\mMTD\M'::text
        ), next_jan AS (
         SELECT
                CASE
                    WHEN CURRENT_DATE <= make_date(EXTRACT(year FROM CURRENT_DATE)::integer, 1, 31) THEN make_date(EXTRACT(year FROM CURRENT_DATE)::integer, 1, 31)
                    ELSE make_date(EXTRACT(year FROM CURRENT_DATE)::integer + 1, 1, 31)
                END AS d
        )
 SELECT (( SELECT count(*) AS count
           FROM ch
          WHERE ch.bm_deadline >= CURRENT_DATE AND ch.bm_deadline < (date_trunc('month'::text, CURRENT_DATE::timestamp with time zone) + '1 mon'::interval)))::integer AS ch_this_month,
    (( SELECT count(*) AS count
           FROM ch
          WHERE ch.bm_deadline >= (date_trunc('month'::text, CURRENT_DATE::timestamp with time zone) + '1 mon'::interval) AND ch.bm_deadline < (date_trunc('month'::text, CURRENT_DATE::timestamp with time zone) + '2 mons'::interval)))::integer AS ch_next_month,
    (( SELECT count(*) AS count
           FROM ch
          WHERE ch.bm_deadline >= CURRENT_DATE AND ch.bm_deadline <= (CURRENT_DATE + '6 mons'::interval)))::integer AS ch_six_months,
    (( SELECT count(*) AS count
           FROM ch
          WHERE ch.bm_deadline < CURRENT_DATE))::integer AS ch_overdue,
    (( SELECT count(*) AS count
           FROM sa,
            next_jan
          WHERE sa.bm_deadline >= CURRENT_DATE AND sa.bm_deadline <= next_jan.d))::integer AS sa_next_jan,
    ( SELECT EXTRACT(year FROM next_jan.d)::integer AS "extract"
           FROM next_jan) AS sa_year,
    (( SELECT count(*) AS count
           FROM sa
          WHERE sa.bm_deadline < CURRENT_DATE))::integer AS sa_overdue,
    (( SELECT count(*) AS count
           FROM base
          WHERE base.bm_deadline < CURRENT_DATE))::integer AS overdue_total,
    ( SELECT COALESCE(jsonb_object_agg(COALESCE(s.service, 'Other'::text), s.n), '{}'::jsonb) AS "coalesce"
           FROM ( SELECT base.service,
                    count(*)::integer AS n
                   FROM base
                  WHERE base.bm_deadline < CURRENT_DATE
                  GROUP BY base.service) s) AS overdue_by_service;
