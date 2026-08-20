-- 249: Only a company pays corporation tax.
--
-- John Rowan is a sole trader and was being flagged for a missing CT
-- authorisation. The CT billing rule is "accounts|corporation tax|ct600|annual
-- statutory|dormant", and he is billed "Accounts:Business Accounts - Sole
-- Trader" — which matches on the word "accounts". Accounts production and
-- corporation tax are not the same thing: a sole trader has real accounts work
-- and no CT at all, because the profit lands on the SA return.
--
-- 24 sole traders and partnerships carried a CT row, 23 of them reading
-- not_authorised. CT is now limited-company only, mirroring the existing SA
-- exclusion for companies, and genuine CT gaps fall from 36 to 13.
--
-- The inverse is worth knowing too: 6 non-companies are billed an actual
-- Corporation Tax product ("Business Accounts and Corporation Tax Combined",
-- and one sole trader on "Business Accounts - Dormant Ltd Company"). Either the
-- entity type is wrong or the wrong product was sold, so that becomes
-- billed_ct_not_a_company and joins billed_vat_not_registered under
-- check_billing — a fee question, not an authorisation one.
--
-- Supersedes the same two views in sql/248; everything else there stands.

create or replace view v_onboarding_crosscheck as
with scope as (
  select e.id as entity_id, e.name as entity_name, e.type as entity_type,
         e.bm_agent_sa, e.bm_agent_ct, e.bm_agent_vat, e.bm_agent_paye,
         e.bm_agent_cis, e.bm_agent_seen_at
    from entities e
   where e.entity_status = 'active'
),
billed as (
  select distinct lb.entity_id, r.tax
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'billing' and (s->>'service_id') ~* r.pattern
     and (r.exclude_pattern is null or (s->>'service_id') !~* r.exclude_pattern)
   where coalesce(lb.status, '') <> 'cancelled'
),
scheduled as (
  select distinct b.entity_id, r.tax
    from bm_task_schedule b
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'bm_task' and b.service ~* r.pattern
     and (r.exclude_pattern is null or b.service !~* r.exclude_pattern)
   where b.excluded_at is null
),
flagged as (
  select distinct o.entity_id, c.cond as tax
    from onboardings o
    cross join lateral unnest(o.service_conditions) c(cond)
   where o.archived_at is null and c.cond in ('ct','sa','vat','paye','cis')
  union
  select e.id, 'vat' from entities e
   where e.entity_status = 'active' and nullif(btrim(e.vat_number),'') is not null
),
we_do as (
  select entity_id, tax,
         bool_or(b) as is_billed, bool_or(s) as is_scheduled, bool_or(f) as is_flagged
    from (
      select entity_id, tax, true as b, false as s, false as f from billed
      union all
      select entity_id, tax, false, true, false from scheduled
      union all
      select entity_id, tax, false, false, true from flagged
    ) u
   group by entity_id, tax
),
registered as (
  select e.id as entity_id, 'vat'::text as tax,
         (nullif(btrim(e.vat_number),'') is not null) as registered, 'VAT number' as ref_name
    from entities e
  union all
  select e.id, 'paye', nullif(btrim(e.paye_ref),'') is not null, 'PAYE reference' from entities e
  union all
  select e.id, 'ct',   nullif(btrim(e.utr),'') is not null, 'company UTR' from entities e
  union all
  select e.id, 'sa',   nullif(btrim(e.utr),'') is not null, 'UTR' from entities e
),
hmrc_rows as (
  select 'paye'::text as tax, c.entity_id as stored_entity, null::uuid as key_entity,
         case when c.link_method in ('exact_ref','normalised_ref') then 'paye_ref'
              when c.link_method = 'name' then 'name'
              else coalesce(c.link_method, 'unknown') end as basis,
         c.last_seen
    from hmrc.client c
  union all
  select 'vat', v.entity_id, k.entity_id, 'vrn', v.last_seen
    from hmrc.vat_client v
    left join lateral (
      select e.id as entity_id from entities e
       where nullif(regexp_replace(coalesce(v.vrn,''), '\D', '', 'g'), '') is not null
         and regexp_replace(coalesce(e.vat_number,''), '\D', '', 'g')
           = regexp_replace(coalesce(v.vrn,''), '\D', '', 'g')
       order by (e.entity_status = 'active') desc limit 1
    ) k on true
  union all
  select 'sa', s.entity_id, k.entity_id, 'utr', s.last_seen
    from hmrc.sa_client s
    left join lateral (
      select e.id as entity_id from entities e
       where length(regexp_replace(coalesce(s.utr,''), '\D', '', 'g')) = 10
         and regexp_replace(coalesce(e.utr,''), '\D', '', 'g')
           = regexp_replace(coalesce(s.utr,''), '\D', '', 'g')
       order by (e.entity_status = 'active') desc limit 1
    ) k on true
  union all
  select 'ct', t.entity_id, k.entity_id, 'utr', t.last_seen
    from hmrc.ct_client t
    left join lateral (
      select e.id as entity_id from entities e
       where length(regexp_replace(coalesce(t.utr,''), '\D', '', 'g')) = 10
         and regexp_replace(coalesce(e.utr,''), '\D', '', 'g')
           = regexp_replace(coalesce(t.utr,''), '\D', '', 'g')
       order by (e.entity_status = 'active') desc limit 1
    ) k on true
),
hmrc_seen as (
  select coalesce(key_entity, stored_entity) as entity_id, tax,
         max(last_seen) as hmrc_last_seen,
         case when bool_or(basis = 'name') then 'name'
              when bool_or(key_entity is null and basis in ('utr','vrn')) then 'scraper_link'
              else min(basis) end as hmrc_link_basis
    from hmrc_rows
   where coalesce(key_entity, stored_entity) is not null
   group by 1, 2
),
runs as (
  select case service when 'corporation-tax' then 'ct'
                      when 'self-assessment' then 'sa'
                      else service end as tax,
         max(finished_at) as last_run
    from hmrc.run where finished_at is not null group by 1
),
combined as (
  select s.entity_id, s.entity_name, s.entity_type, t.tax,
         coalesce(w.is_billed, false)    as is_billed,
         coalesce(w.is_scheduled, false) as is_scheduled,
         coalesce(w.is_flagged, false)   as is_flagged,
         (w.entity_id is not null)       as we_do,
         (h.entity_id is not null)       as hmrc_agent,
         h.hmrc_last_seen, h.hmrc_link_basis,
         rn.last_run as hmrc_last_run,
         rg.registered, rg.ref_name,
         case t.tax when 'sa' then s.bm_agent_sa when 'ct' then s.bm_agent_ct
                    when 'vat' then s.bm_agent_vat when 'paye' then s.bm_agent_paye
                    when 'cis' then s.bm_agent_cis end as bm_agent,
         s.bm_agent_seen_at
    from scope s
    cross join (values ('ct'),('sa'),('vat'),('paye'),('cis')) t(tax)
    left join we_do      w  on w.entity_id = s.entity_id and w.tax = t.tax
    left join hmrc_seen  h  on h.entity_id = s.entity_id and h.tax = t.tax
    left join registered rg on rg.entity_id = s.entity_id and rg.tax = t.tax
    left join runs       rn on rn.tax = t.tax
   where (w.entity_id is not null or h.entity_id is not null)
     -- A company never holds its own SA authorisation: directors' returns are
     -- billed to the company but authorised on the director's personal UTR.
     and not (t.tax = 'sa' and s.entity_type = 'limited_company')
     -- And only a company pays corporation tax. "Business Accounts - Sole
     -- Trader" matched the CT rule on the word "accounts", so 24 sole traders
     -- and partnerships were being asked for a CT authorisation that cannot
     -- exist. Their accounts work is real; it lands on the SA return.
     and not (t.tax = 'ct' and s.entity_type <> 'limited_company')
),
coverage as (
  select tax,
         count(*) filter (where we_do and registered is not false) as we_do_clients,
         count(*) filter (where hmrc_agent)                        as hmrc_clients,
         max(hmrc_last_run)                                        as last_run,
         case when count(*) filter (where we_do and registered is not false) = 0 then null
              else round(count(*) filter (where hmrc_agent)::numeric
                         / count(*) filter (where we_do and registered is not false), 3)
         end as coverage_ratio
    from combined group by tax
)
select c.*,
       cv.coverage_ratio,
       (cv.coverage_ratio is not null and cv.coverage_ratio < 0.6) as scrape_looks_partial,
       o.id            as onboarding_id,
       o.status        as onboarding_status,
       o.completed_at  as onboarding_completed_at,
       case
         when c.hmrc_last_run is null and not c.hmrc_agent then 'no_evidence'
         when c.we_do and c.hmrc_agent and c.bm_agent is false then 'bm_wrong'
         when c.we_do and c.hmrc_agent then 'authorised'
         when c.we_do and not c.hmrc_agent and c.registered is false then 'awaiting_registration'
         when c.we_do and not c.hmrc_agent
              and cv.coverage_ratio is not null and cv.coverage_ratio < 0.6 then 'unverified'
         when c.we_do and not c.hmrc_agent then 'not_authorised'
         when not c.we_do and c.hmrc_agent then 'agent_but_no_service'
       end as verdict,
       case
         when c.hmrc_last_run is null and not c.hmrc_agent
           then 'No HMRC scrape covers this tax, so authorisation cannot be confirmed either way'
         when c.we_do and c.hmrc_agent and c.bm_agent is false
           then 'HMRC lets us scrape this client, so we ARE the agent — BrightManager says otherwise and needs fixing'
         when c.we_do and c.hmrc_agent and c.hmrc_link_basis = 'name'
           then 'Authorised at HMRC, but this account was matched to the client by name rather than by reference — confirm it is the right one'
         when c.we_do and c.hmrc_agent then 'Authorised at HMRC and the service is switched on'
         when c.we_do and not c.hmrc_agent and c.registered is false
           then 'No ' || coalesce(c.ref_name,'reference') || ' on record yet, so there is nothing to be authorised for — a registration in progress, not a missing authorisation'
         when c.we_do and not c.hmrc_agent
              and cv.coverage_ratio is not null and cv.coverage_ratio < 0.6
           then 'Not on the scraped agent list, but that scrape only reached '
                || round(cv.coverage_ratio * 100) || '% of the registered clients we act for — confirm the scrape is complete before treating this as unauthorised'
         when c.we_do and not c.hmrc_agent
           then 'We are doing this work but HMRC has never shown this client on our agent list — authorisation is missing'
         when not c.we_do and c.hmrc_agent
           then 'We are the authorised agent but no fee or scheduled work covers it — either an unbilled service or an authorisation to give up'
       end as verdict_detail
  from combined c
  join coverage cv on cv.tax = c.tax
  left join lateral (
    select o2.id, o2.status, o2.completed_at
      from onboardings o2
     where o2.entity_id = c.entity_id and o2.archived_at is null
     order by o2.created_at desc limit 1
  ) o on true
 where is_staff_or_service();

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
         when c.agent_no_service > 0                              then 'review_authorisation'
         when c.billed_vat_not_registered or c.billed_ct_not_a_company then 'check_billing'
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
         when c.agent_no_service > 0                              then 4
         when c.billed_vat_not_registered or c.billed_ct_not_a_company then 5
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
           -- The inverse of the CT scoping fix: a sole trader or partnership
           -- billed an actual Corporation Tax product. Either the entity type
           -- is wrong or the wrong product was sold — a fee question, like
           -- billed_vat_not_registered, not an authorisation one.
           (e.type <> 'limited_company' and exists (
              select 1 from live_billing lb
              cross join lateral jsonb_array_elements(lb.services) s
               where lb.entity_id = e.id and coalesce(lb.status,'') <> 'cancelled'
                 and (s->>'service_id') ~* 'corporation tax|ct600'
           )) as billed_ct_not_a_company
      from v_onboarding_crosscheck_client cc
      join entities e on e.id = cc.entity_id
     -- This view reads entities directly, so it carries its own predicate
     -- rather than leaning on the inner view's. The posture audit flagged the
     -- shape (definer view over a base table with no gate) even though the
     -- inner view meant no rows actually escaped — the shape is the bug.
     where is_staff_or_service()
  ) c;

comment on view v_onboarding_crosscheck_board is 'The verdict per client: keep_on_board / not_set_up / fix_bm / review_authorisation / check_billing / loose_end / awaiting_registration / clean, plus wrongly_closed and ready_to_close. Set-up checks (BrightPay, TaxCalc) only bite once the registration they depend on exists; awaiting_registration is a legitimate in-progress state. check_billing covers a VAT product sold to a non-registered client and a Corporation Tax product sold to a non-company. Carries its own is_staff_or_service() predicate because it reads entities directly. not_billed is context only.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
