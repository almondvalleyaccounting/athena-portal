-- 250: Audit of the SA and PAYE rules, and what it changed.
--
-- Asked to check SA and PAYE the way CT and VAT were checked, since twice a
-- product name had been mistaken for a tax registration.
--
-- PAYE holds up. The billing rule catches only "Payroll Related:Payroll" and
-- the legacy "Payroll" — 88 clients, no strays; the pension/auto-enrolment
-- patterns match nothing billed. On the BM side, "Pensions" is a sound proxy
-- for an employer: 84 of its 87 clients hold a PAYE reference, 79 are on
-- HMRC's PAYE list, 70 are on BrightPay. No change needed.
--
-- SA produces no false positives either, but it is nearly redundant and it
-- hides something. Only 47 of 314 SA rows come from billing; 252 come from BM
-- scheduled work alone. The reason is that most SA billing sits on companies
-- ("Tax Returns - Individual" billed to the company for its directors), and
-- companies are correctly excluded from SA rows — so the signal is dropped.
--
-- Two changes fall out of it:
--
-- 1. The 28 PAYE authorisations with no service split cleanly in half.
--    14 have a BrightPay employer: we are running the payroll and nothing
--    bills it. That is a fee question, so payroll_unbilled joins
--    check_billing. The other 14 have no payroll anywhere — a dormant scheme
--    to disengage from, so paye_authorisation_dormant stays under
--    review_authorisation. One lumped verdict became two different jobs.
--
-- 2. The SA blind spot is now visible instead of silent. 93 companies pay us
--    for their directors' returns. The fee is on the company, the
--    authorisation is on a person, and public.people holds no UTR — so there
--    is no key from one to the other and not one of those authorisations can
--    be checked. directors_sa_unverifiable marks them, and the Evidence strip
--    says so, rather than an empty SA column implying all is well. Closing it
--    properly means recording director UTRs.
--
-- Supersedes the board view in sql/249; everything else there stands.

drop view if exists v_onboarding_crosscheck_board cascade;
create view v_onboarding_crosscheck_board as
select c.*,
       (c.payroll_not_on_brightpay and c.paye_registered)            as brightpay_missing,
       (coalesce(c.missing_from_taxcalc,false) and c.utr_registered)  as taxcalc_missing,
       case
         when c.has_onboarding and not c.loe_signed              then 'keep_on_board'
         when c.missing_authorisations > 0                        then 'keep_on_board'
         when (c.payroll_not_on_brightpay and c.paye_registered)
           or c.software_without_qbo
           or (coalesce(c.missing_from_taxcalc, false) and c.utr_registered) then 'not_set_up'
         when c.bm_disagreements > 0                              then 'fix_bm'
         -- Work we do that nobody bills is a fee question, so it sits with the
         -- other billing mismatches rather than under authorisation review.
         when c.billed_vat_not_registered or c.billed_ct_not_a_company
           or c.payroll_unbilled                                  then 'check_billing'
         when c.agent_no_service > 0                              then 'review_authorisation'
         when c.company_no_ch_auth_code or c.loe_from_bm_only     then 'loose_end'
         when c.awaiting_registration > 0                         then 'awaiting_registration'
         else 'clean'
       end as verdict,
       case
         when (c.has_onboarding and not c.loe_signed) or c.missing_authorisations > 0 then 1
         when (c.payroll_not_on_brightpay and c.paye_registered)
           or c.software_without_qbo
           or (coalesce(c.missing_from_taxcalc, false) and c.utr_registered) then 2
         when c.bm_disagreements > 0                              then 3
         when c.billed_vat_not_registered or c.billed_ct_not_a_company
           or c.payroll_unbilled                                  then 4
         when c.agent_no_service > 0                              then 5
         when c.company_no_ch_auth_code or c.loe_from_bm_only     then 6
         when c.awaiting_registration > 0                         then 7
         else 9
       end as severity,
       (c.onboarding_status = 'complete'
         and (not c.loe_signed or c.missing_authorisations > 0)) as wrongly_closed,
       (c.has_onboarding and c.onboarding_status <> 'complete'
         and c.loe_signed and c.missing_authorisations = 0
         and not (c.payroll_not_on_brightpay and c.paye_registered)
         and not c.software_without_qbo
         and c.awaiting_registration = 0) as ready_to_close
  from (
    select cc.*,
           nullif(btrim(e.paye_ref),'') is not null as paye_registered,
           nullif(btrim(e.utr),'')      is not null as utr_registered,
           -- A sole trader or partnership billed an actual Corporation Tax
           -- product: either the client type is wrong or the wrong product was
           -- sold. The inverse of the CT scoping fix in sql/249.
           (e.type <> 'limited_company' and exists (
              select 1 from live_billing lb
              cross join lateral jsonb_array_elements(lb.services) s
               where lb.entity_id = e.id and coalesce(lb.status,'') <> 'cancelled'
                 and (s->>'service_id') ~* 'corporation tax|ct600'
           )) as billed_ct_not_a_company,
           -- We hold the PAYE authorisation AND BrightPay holds the payroll,
           -- but nothing bills or schedules it. 14 clients: we are running
           -- payroll for free. The other 14 PAYE authorisations with no
           -- service have no payroll anywhere, which is a dormant scheme to
           -- disengage from — a different job, so a different flag.
           exists (
             select 1 from v_onboarding_crosscheck x
              where x.entity_id = e.id and x.tax = 'paye'
                and x.verdict = 'agent_but_no_service'
           ) and exists (
             select 1 from hmrc.brightpay_link l where l.entity_id = e.id
           ) as payroll_unbilled,
           exists (
             select 1 from v_onboarding_crosscheck x
              where x.entity_id = e.id and x.tax = 'paye'
                and x.verdict = 'agent_but_no_service'
           ) and not exists (
             select 1 from hmrc.brightpay_link l where l.entity_id = e.id
           ) as paye_authorisation_dormant,
           -- The blind spot, made visible rather than left silent. 93
           -- companies pay us for their directors' Self Assessment. The fee
           -- sits on the company and the authorisation sits on a person, and
           -- people holds no UTR — so there is no key from one to the other
           -- and none of those authorisations can be checked here. Companies
           -- are correctly excluded from SA rows; this says why the column is
           -- empty rather than implying all is well.
           (e.type = 'limited_company' and exists (
              select 1 from live_billing lb
              cross join lateral jsonb_array_elements(lb.services) s
               where lb.entity_id = e.id and coalesce(lb.status,'') <> 'cancelled'
                 and (s->>'service_id') ~* 'tax returns - individual|self assessment|all inclusive'
           )) as directors_sa_unverifiable
      from v_onboarding_crosscheck_client cc
      join entities e on e.id = cc.entity_id
     -- This view reads entities directly, so it carries its own predicate
     -- rather than leaning on the inner view's. The posture audit flagged the
     -- shape (definer view over a base table with no gate) even though the
     -- inner view meant no rows actually escaped — the shape is the bug.
     where is_staff_or_service()
  ) c;

comment on view v_onboarding_crosscheck_board is 'The verdict per client: keep_on_board / not_set_up / fix_bm / check_billing / review_authorisation / loose_end / awaiting_registration / clean, plus wrongly_closed and ready_to_close. check_billing covers a VAT product sold to a non-registered client, a CT product sold to a non-company, and payroll we run on BrightPay that nothing bills. paye_authorisation_dormant marks a PAYE authorisation with no payroll anywhere. directors_sa_unverifiable marks the 93 companies whose directors SA authorisation cannot be reached from Athena. Carries its own is_staff_or_service() predicate because it reads entities directly.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
