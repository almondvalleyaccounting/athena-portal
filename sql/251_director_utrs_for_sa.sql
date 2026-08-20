-- 251: Directors UTRs, so directors Self Assessment can actually be checked.
--
-- 93 companies pay us for their directors returns. The fee sits on the company
-- and the authorisation sits on a person, and sql/250 could only mark that as
-- unverifiable. It turned out to be less a missing-data problem than an unused
-- link: entity_people already records directors, and 83 of those 93 companies
-- reach the directors own client record through it — 78 with a UTR already on
-- file. Nothing needed adding for those. They needed wiring up.
--
-- So the check resolves a UTR per director, their own client record first and
-- then people.utr, and matches HMRCs SA list on the UTR itself rather than on
-- the entity. That last part is what makes the column worth having: a director
-- who is not a client at all can still be checked the moment someone records
-- their UTR, with nothing else to set up.
--
-- Where that lands today, across 128 director rows:
--   23 authorised   — confirmed against HMRC on the directors own UTR
--   71 unverified   — UTR known, not on the SA list, but that scrape reaches
--                     only 31% of registered clients, so it proves nothing
--   34 no_utr       — 27 companies with a director to record a UTR for
--    0 not_authorised
--
-- The 71 resolve on their own once the SA scrape covers the whole agent list.
-- A director with no UTR is a loose end to capture; one HMRC has never shown
-- us as agent for is a missing authorisation and keeps the client on the board.
--
-- Supersedes the board view in sql/250; everything else there stands.

-- ── A UTR belongs to a person ────────────────────────────────────────────
alter table people
  add column if not exists utr text;
comment on column people.utr is 'Personal UTR for a director who is not a client in their own right. Where the director IS a client, their entity already holds the UTR and that is used first — this column only fills the gap. Feeds v_onboarding_crosscheck_director_sa.';

create index if not exists idx_people_utr on people(utr) where utr is not null;

-- ── Directors' Self Assessment, resolved per director ────────────────────
-- The blind spot was never missing data so much as an unused link. 93 companies
-- pay us for their directors' returns; 83 of them already reach the director's
-- own client record through entity_people (company → person → their own
-- entity), and 78 of those carry a UTR. Nothing needed adding for those — they
-- needed wiring up.
--
-- The authorisation is matched on the UTR itself, not on the director's entity,
-- so a director who is not a client at all can still be checked as soon as
-- someone records their UTR in people.utr. That is what this buys.
--
-- One row per (company, director). Definer over the private hmrc schema, with
-- its own predicate.
create or replace view v_onboarding_crosscheck_director_sa as
with billing_companies as (
  select distinct lb.entity_id
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
   where coalesce(lb.status,'') <> 'cancelled'
     and (s->>'service_id') ~* 'tax returns - individual|self assessment|all inclusive'
),
companies as (
  select e.id as company_id, e.name as company_name
    from entities e
    join billing_companies bc on bc.entity_id = e.id
   where e.entity_status = 'active' and e.type = 'limited_company'
),
directors as (
  select c.company_id, c.company_name,
         p.id as person_id,
         coalesce(nullif(btrim(p.name),''),
                  btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,''))) as director_name,
         nullif(btrim(p.utr),'') as person_utr
    from companies c
    join entity_people ep on ep.entity_id = c.company_id and ep.role = 'director'
    join people p on p.id = ep.person_id
),
-- The director's own client record, where they are a client too. Companies are
-- excluded: a director's personal record is never a company.
own_entity as (
  select distinct on (d.company_id, d.person_id)
         d.company_id, d.person_id, de.id as director_entity_id, de.name as director_entity_name,
         nullif(btrim(de.utr),'') as entity_utr
    from directors d
    join entity_people pe on pe.person_id = d.person_id and pe.entity_id <> d.company_id
    join entities de on de.id = pe.entity_id and de.type <> 'limited_company'
   order by d.company_id, d.person_id, (de.entity_status = 'active') desc, de.name
),
resolved as (
  select d.company_id, d.company_name, d.person_id, d.director_name,
         oe.director_entity_id, oe.director_entity_name,
         -- Their own client record first, then a UTR typed against the person.
         coalesce(oe.entity_utr, d.person_utr) as utr,
         case when oe.entity_utr is not null then 'own client record'
              when d.person_utr is not null then 'recorded against the person'
              else null end as utr_source
    from directors d
    left join own_entity oe on oe.company_id = d.company_id and oe.person_id = d.person_id
),
-- Matched on the UTR, so a director who is not a client can still be checked.
sa_match as (
  select r.*,
         exists (
           select 1 from hmrc.sa_client sc
            where regexp_replace(coalesce(sc.utr,''), '\D', '', 'g')
                = regexp_replace(coalesce(r.utr,''), '\D', '', 'g')
              and length(regexp_replace(coalesce(r.utr,''), '\D', '', 'g')) = 10
         ) as on_sa_list
    from resolved r
),
-- The SA scrape's coverage decides whether absence means anything, exactly as
-- it does for clients.
sa_cover as (
  select bool_or(scrape_looks_partial) as partial,
         max(coverage_ratio) as ratio
    from v_onboarding_crosscheck where tax = 'sa'
)
select m.company_id, m.company_name, m.person_id, m.director_name,
       m.director_entity_id, m.director_entity_name,
       m.utr, m.utr_source, m.on_sa_list,
       case
         when m.utr is null                       then 'no_utr'
         when m.on_sa_list                        then 'authorised'
         when (select partial from sa_cover)      then 'unverified'
         else 'not_authorised'
       end as verdict,
       case
         when m.utr is null
           then 'No UTR for this director — record one against the person and the check runs immediately'
         when m.on_sa_list
           then 'On HMRC''s Self Assessment list, so we are the authorised agent for their return'
         when (select partial from sa_cover)
           then 'Not on the scraped SA list, but that scrape reached only '
                || round((select ratio from sa_cover) * 100) || '% of the registered clients we act for'
         else 'We bill for this return but HMRC has never shown the director on our SA list'
       end as verdict_detail
  from sa_match m
 where is_staff_or_service();

comment on view v_onboarding_crosscheck_director_sa is 'One row per (company, director) for companies billed for directors Self Assessment. Resolves the director UTR from their own client record first, then people.utr, and matches HMRC''s SA list on the UTR itself so a director who is not a client can still be checked. Definer over the private hmrc schema.';
grant select on v_onboarding_crosscheck_director_sa to authenticated, service_role;
revoke all on v_onboarding_crosscheck_director_sa from public;
revoke all on v_onboarding_crosscheck_director_sa from anon;

drop view if exists v_onboarding_crosscheck_board cascade;
create view v_onboarding_crosscheck_board as
select c.*,
       (c.payroll_not_on_brightpay and c.paye_registered)            as brightpay_missing,
       (coalesce(c.missing_from_taxcalc,false) and c.utr_registered)  as taxcalc_missing,
       case
         when c.has_onboarding and not c.loe_signed              then 'keep_on_board'
         when c.missing_authorisations > 0                        then 'keep_on_board'
         -- A director we bill for whose return HMRC has never shown us as
         -- agent for is a missing authorisation like any other.
         when c.directors_sa_not_authorised > 0                   then 'keep_on_board'
         when (c.payroll_not_on_brightpay and c.paye_registered)
           or c.software_without_qbo
           or (coalesce(c.missing_from_taxcalc, false) and c.utr_registered) then 'not_set_up'
         when c.bm_disagreements > 0                              then 'fix_bm'
         when c.billed_vat_not_registered or c.billed_ct_not_a_company
           or c.payroll_unbilled                                  then 'check_billing'
         when c.agent_no_service > 0                              then 'review_authorisation'
         -- A director with no UTR anywhere is data to capture, not a failure.
         when c.company_no_ch_auth_code or c.loe_from_bm_only
           or c.directors_sa_no_utr > 0                           then 'loose_end'
         when c.awaiting_registration > 0                         then 'awaiting_registration'
         else 'clean'
       end as verdict,
       case
         when (c.has_onboarding and not c.loe_signed) or c.missing_authorisations > 0
           or c.directors_sa_not_authorised > 0                   then 1
         when (c.payroll_not_on_brightpay and c.paye_registered)
           or c.software_without_qbo
           or (coalesce(c.missing_from_taxcalc, false) and c.utr_registered) then 2
         when c.bm_disagreements > 0                              then 3
         when c.billed_vat_not_registered or c.billed_ct_not_a_company
           or c.payroll_unbilled                                  then 4
         when c.agent_no_service > 0                              then 5
         when c.company_no_ch_auth_code or c.loe_from_bm_only
           or c.directors_sa_no_utr > 0                           then 6
         when c.awaiting_registration > 0                         then 7
         else 9
       end as severity,
       (c.onboarding_status = 'complete'
         and (not c.loe_signed or c.missing_authorisations > 0
              or c.directors_sa_not_authorised > 0)) as wrongly_closed,
       (c.has_onboarding and c.onboarding_status <> 'complete'
         and c.loe_signed and c.missing_authorisations = 0
         and c.directors_sa_not_authorised = 0 and c.directors_sa_no_utr = 0
         and not (c.payroll_not_on_brightpay and c.paye_registered)
         and not c.software_without_qbo
         and c.awaiting_registration = 0) as ready_to_close
  from (
    select cc.*,
           nullif(btrim(e.paye_ref),'') is not null as paye_registered,
           nullif(btrim(e.utr),'')      is not null as utr_registered,
           (e.type <> 'limited_company' and exists (
              select 1 from live_billing lb
              cross join lateral jsonb_array_elements(lb.services) s
               where lb.entity_id = e.id and coalesce(lb.status,'') <> 'cancelled'
                 and (s->>'service_id') ~* 'corporation tax|ct600'
           )) as billed_ct_not_a_company,
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
           -- Directors' SA, resolved per director rather than left silent.
           -- 83 of the 93 companies reach the director's own client record
           -- through entity_people, and the UTR is matched against HMRC's list
           -- directly — so recording a UTR against a person makes the check run.
           coalesce(ds.directors, 0)          as directors_billed_for_sa,
           coalesce(ds.authorised, 0)         as directors_sa_authorised,
           coalesce(ds.no_utr, 0)             as directors_sa_no_utr,
           coalesce(ds.not_authorised, 0)     as directors_sa_not_authorised,
           coalesce(ds.unverified, 0)         as directors_sa_unverified
      from v_onboarding_crosscheck_client cc
      join entities e on e.id = cc.entity_id
      left join (
        select company_id,
               count(*)                                          as directors,
               count(*) filter (where verdict = 'authorised')     as authorised,
               count(*) filter (where verdict = 'no_utr')         as no_utr,
               count(*) filter (where verdict = 'not_authorised') as not_authorised,
               count(*) filter (where verdict = 'unverified')     as unverified
          from v_onboarding_crosscheck_director_sa
         group by company_id
      ) ds on ds.company_id = cc.entity_id
     -- This view reads entities directly, so it carries its own predicate
     -- rather than leaning on the inner view's.
     where is_staff_or_service()
  ) c;

comment on view v_onboarding_crosscheck_board is 'The verdict per client: keep_on_board / not_set_up / fix_bm / check_billing / review_authorisation / loose_end / awaiting_registration / clean, plus wrongly_closed and ready_to_close. Directors Self Assessment is resolved per director (see v_onboarding_crosscheck_director_sa): a director with no UTR is a loose end to capture, one HMRC has never authorised us for is a missing authorisation. Carries its own is_staff_or_service() predicate because it reads entities directly.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
