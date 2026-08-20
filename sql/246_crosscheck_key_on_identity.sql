-- 246: Key the cross-check's HMRC leg on identity, not on the scraper's link.
--
-- v_onboarding_crosscheck (sql/243) took hmrc.*_client.entity_id at face value.
-- That column is whatever the scraper managed to match on, and for PAYE two of
-- those matches were made on the company NAME — including Tapee Ltd, linked to
-- HMRC scheme 120/UE41300 while Athena holds 120/LF09269 for it. A name is a
-- label; the reference and the UTR are the identity.
--
-- So the view now resolves the client itself, on the key each tax actually has:
--
--   SA, CT   the 10-digit UTR
--   VAT      the VRN
--   PAYE     the scheme reference — a PAYE account has no UTR, so there is no
--            better key available. The stored link stands, but how it was made
--            is carried through as hmrc_link_basis so a name match is visible
--            rather than silently counting as proof of authorisation.
--
-- Re-keyed, today's numbers are identical: SA 89/89 agree on UTR, CT 222/222,
-- VAT 100/100 on VRN. The point is that the view no longer inherits a bad link
-- if one appears later, and that it now says which basis it used.
--
-- Duplicate keys resolve to the active entity: Thomson, Stewart exists twice
-- (archived and active) on one UTR, and a plain join would match both.
drop view if exists v_onboarding_crosscheck cascade;
create view v_onboarding_crosscheck as
with scope as (
  select e.id as entity_id, e.name as entity_name, e.type as entity_type,
         e.bm_agent_sa, e.bm_agent_ct, e.bm_agent_vat, e.bm_agent_paye,
         e.bm_agent_cis, e.bm_agent_seen_at
    from entities e
   where e.entity_status = 'active'
),
-- What we think we do: the committed fee (what the client pays for) …
billed as (
  select distinct lb.entity_id, r.tax
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'billing' and (s->>'service_id') ~* r.pattern
   where coalesce(lb.status, '') <> 'cancelled'
     -- Modulr is a payment rail bought alongside payroll, not payroll itself
     and not (r.tax = 'paye' and (s->>'service_id') ~* 'modulr')
),
-- … and the work BrightManager actually has scheduled for them.
scheduled as (
  select distinct b.entity_id, r.tax
    from bm_task_schedule b
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'bm_task' and b.service ~* r.pattern
   where b.excluded_at is null
),
we_do as (
  select entity_id, tax, bool_or(billed) as is_billed, bool_or(sched) as is_scheduled
    from (
      select entity_id, tax, true as billed, false as sched from billed
      union all
      select entity_id, tax, false, true from scheduled
    ) u
   group by entity_id, tax
),
-- ── Hard evidence, resolved on the identity key ──────────────────────────
-- One row per scraped HMRC client account: who the scraper linked it to, who
-- the key says it is, and how firm that answer is.
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
       order by (e.entity_status = 'active') desc
       limit 1
    ) k on true
  union all
  select 'sa', s.entity_id, k.entity_id, 'utr', s.last_seen
    from hmrc.sa_client s
    left join lateral (
      select e.id as entity_id from entities e
       where length(regexp_replace(coalesce(s.utr,''), '\D', '', 'g')) = 10
         and regexp_replace(coalesce(e.utr,''), '\D', '', 'g')
           = regexp_replace(coalesce(s.utr,''), '\D', '', 'g')
       order by (e.entity_status = 'active') desc
       limit 1
    ) k on true
  union all
  select 'ct', t.entity_id, k.entity_id, 'utr', t.last_seen
    from hmrc.ct_client t
    left join lateral (
      select e.id as entity_id from entities e
       where length(regexp_replace(coalesce(t.utr,''), '\D', '', 'g')) = 10
         and regexp_replace(coalesce(e.utr,''), '\D', '', 'g')
           = regexp_replace(coalesce(t.utr,''), '\D', '', 'g')
       order by (e.entity_status = 'active') desc
       limit 1
    ) k on true
),
hmrc_seen as (
  select coalesce(key_entity, stored_entity) as entity_id,
         tax,
         max(last_seen) as hmrc_last_seen,
         -- The weakest basis behind this client wins, so one name match is not
         -- hidden by a firm one alongside it.
         case when bool_or(basis = 'name') then 'name'
              when bool_or(key_entity is null and basis in ('utr','vrn')) then 'scraper_link'
              else min(basis) end as hmrc_link_basis
    from hmrc_rows
   where coalesce(key_entity, stored_entity) is not null
   group by 1, 2
),
-- Whether the scrape has ever run for a tax at all. Absence of a client from
-- a list that was never scraped proves nothing.
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
         (w.entity_id is not null)       as we_do,
         (h.entity_id is not null)       as hmrc_agent,
         h.hmrc_last_seen,
         h.hmrc_link_basis,
         rn.last_run as hmrc_last_run,
         case t.tax when 'sa' then s.bm_agent_sa when 'ct' then s.bm_agent_ct
                    when 'vat' then s.bm_agent_vat when 'paye' then s.bm_agent_paye
                    when 'cis' then s.bm_agent_cis end as bm_agent,
         s.bm_agent_seen_at
    from scope s
    cross join (values ('ct'),('sa'),('vat'),('paye'),('cis')) t(tax)
    left join we_do     w  on w.entity_id = s.entity_id and w.tax = t.tax
    left join hmrc_seen h  on h.entity_id = s.entity_id and h.tax = t.tax
    left join runs      rn on rn.tax = t.tax
   where (w.entity_id is not null or h.entity_id is not null)
     -- A limited company never holds its own SA authorisation: directors'
     -- returns are billed to the company but authorised on the director's
     -- personal UTR, which is a different entity with its own row here.
     and not (t.tax = 'sa' and s.entity_type = 'limited_company')
),
-- A scrape that reached a third of the clients we act for is evidence the
-- scrape is incomplete, not that two thirds of the file is wrong.
coverage as (
  select tax,
         count(*) filter (where we_do)      as we_do_clients,
         count(*) filter (where hmrc_agent) as hmrc_clients,
         max(hmrc_last_run)                 as last_run,
         case when count(*) filter (where we_do) = 0 then null
              else round(count(*) filter (where hmrc_agent)::numeric
                         / count(*) filter (where we_do), 3) end as coverage_ratio
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
         when c.we_do and not c.hmrc_agent
              and cv.coverage_ratio is not null and cv.coverage_ratio < 0.6
           then 'Not on the scraped agent list, but that scrape only reached '
                || round(cv.coverage_ratio * 100) || '% of the clients we act for — confirm the scrape is complete before treating this as unauthorised'
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
     order by o2.created_at desc
     limit 1
  ) o on true
 where is_staff_or_service();

comment on view v_onboarding_crosscheck is 'Per client per tax: what we think we do (fee engine + BM scheduled work), what BrightManager says about agent authorisation, and what the HMRC scrape proves. The HMRC side is resolved on the identity key — UTR for SA/CT, VRN for VAT, scheme reference for PAYE — rather than inheriting the scraper''s entity link, and hmrc_link_basis says which was used. Company SA rows are excluded. Sub-60% scrape coverage reads unverified, not not_authorised. Definer over the private hmrc schema; booleans and dates only.';
grant select on v_onboarding_crosscheck to authenticated, service_role;
revoke all on v_onboarding_crosscheck from public;
revoke all on v_onboarding_crosscheck from anon;

-- Where the scraper's link and the identity key disagree, or where a link was
-- made on a name. Small by design — one row here is a client whose HMRC
-- account may not be the account we think it is.
create or replace view v_onboarding_crosscheck_link_conflicts as
select 'paye'::text as tax, c.paye_ref as hmrc_key, c.name as hmrc_name,
       c.entity_id, c.entity_name, e.paye_ref as athena_key, c.link_method,
       case when c.link_method = 'name' and nullif(btrim(e.paye_ref),'') is null
              then 'Matched on name only — Athena holds no PAYE reference for this client'
            when c.link_method = 'name'
              then 'Matched on name, and Athena holds a different PAYE reference — one of the two is wrong, or the client has a second scheme'
            else 'Matched on a normalised reference rather than an exact one'
       end as note
  from hmrc.client c
  left join entities e on e.id = c.entity_id
 where c.link_method in ('name', 'normalised_ref')
   and is_staff_or_service();

comment on view v_onboarding_crosscheck_link_conflicts is 'HMRC accounts whose link to a client rests on a name or a normalised reference rather than an exact identity key. PAYE only — SA, CT and VAT are resolved on UTR/VRN and cannot drift this way.';
grant select on v_onboarding_crosscheck_link_conflicts to authenticated, service_role;
revoke all on v_onboarding_crosscheck_link_conflicts from public;
revoke all on v_onboarding_crosscheck_link_conflicts from anon;

-- ── Rebuilt unchanged, because the drop above cascaded to them ───────────
create or replace view v_onboarding_crosscheck_coverage as
select tax,
       count(*) filter (where we_do)      as we_do_clients,
       count(*) filter (where hmrc_agent) as hmrc_clients,
       max(coverage_ratio)                as coverage_ratio,
       bool_or(scrape_looks_partial)      as scrape_looks_partial,
       max(hmrc_last_run)                 as last_scrape
  from v_onboarding_crosscheck
 group by tax;

comment on view v_onboarding_crosscheck_coverage is 'Per tax: how many clients we act for, how many the HMRC scrape reached, and whether that coverage is too thin to draw conclusions from.';
grant select on v_onboarding_crosscheck_coverage to authenticated, service_role;
revoke all on v_onboarding_crosscheck_coverage from public;
revoke all on v_onboarding_crosscheck_coverage from anon;

create or replace view v_onboarding_crosscheck_client as
with base as (
  select e.id as entity_id, e.name as entity_name, e.type as entity_type,
         e.utr, e.vat_number, e.paye_ref, e.ch_auth_code,
         e.bm_agent_seen_at, e.taxcalc_accounts_seen_at, e.taxcalc_tax_return_seen_at
    from entities e
   where e.entity_status = 'active'
),
ob as (
  select distinct on (o.entity_id)
         o.entity_id, o.id as onboarding_id, o.status as onboarding_status,
         o.completed_at as onboarding_completed_at, o.started_at, o.owner_id
    from onboardings o
   where o.archived_at is null
   order by o.entity_id, o.created_at desc
),
-- A step a person ticked counts. A step the onboarding-level Complete button
-- ticked (sql/242) does not — closing a client out must never launder itself
-- into evidence that the letter was signed.
loe as (
  select s.onboarding_id,
         bool_or(s.status = 'complete' and s.auto_completed_at is null) as loe_signed,
         bool_or(s.auto_completed_at is not null)                        as loe_closed_out,
         max(s.completed_at) filter (where s.auto_completed_at is null)  as loe_signed_at
    from onboarding_steps s
   where s.name ~* 'letter of engagement'
   group by s.onboarding_id
),
tax as (
  select entity_id,
         count(*) filter (where verdict = 'not_authorised')       as missing_authorisations,
         count(*) filter (where verdict = 'bm_wrong')             as bm_disagreements,
         count(*) filter (where verdict = 'agent_but_no_service') as agent_no_service,
         count(*) filter (where verdict in ('unverified','no_evidence')) as unprovable,
         count(*) filter (where hmrc_agent and hmrc_link_basis = 'name') as name_matched_accounts,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'not_authorised') as unauthorised_taxes,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'bm_wrong')       as bm_wrong_taxes,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'unverified')     as unverified_taxes,
         bool_or(we_do and tax = 'paye')  as does_payroll,
         bool_or(we_do and tax = 'vat')   as does_vat,
         bool_or(we_do and tax = 'ct')    as does_accounts_ct,
         bool_or(we_do and tax = 'sa')    as does_sa
    from v_onboarding_crosscheck
   group by entity_id
),
-- BrightPay through hmrc.brightpay_link (employer → entity by name, 119 of 127
-- matched) because v_wp_paye_readiness.has_brightpay is false for every
-- client — that leg was never fed.
bp as (
  select l.entity_id, max(l.employer_name) as brightpay_employer,
         bool_or(coalesce(em.active, false)) as brightpay_active
    from hmrc.brightpay_link l
    left join payroll.employer em on em.id = l.employer_id
   where l.entity_id is not null
   group by l.entity_id
),
qbo as (
  select entity_id, has_qbo from v_wp_paye_readiness
),
soft as (
  select distinct lb.entity_id
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
   where coalesce(lb.status,'') <> 'cancelled' and (s->>'service_id') ~* 'software'
),
billed_any as (
  select entity_id from live_billing where coalesce(status,'') <> 'cancelled' group by 1
),
portal as (
  select entity_id, bool_or(claimed_at is not null) as portal_claimed,
         count(*) as portal_invites
    from client_portal_invites group by 1
)
select b.entity_id, b.entity_name, b.entity_type,
       o.onboarding_id, o.onboarding_status, o.onboarding_completed_at, o.started_at,
       (o.onboarding_id is not null) as has_onboarding,

       coalesce(l.loe_signed, false) as loe_signed,
       l.loe_signed_at,
       coalesce(l.loe_closed_out, false) as loe_closed_out,

       coalesce(t.missing_authorisations, 0) as missing_authorisations,
       t.unauthorised_taxes,
       coalesce(t.bm_disagreements, 0) as bm_disagreements,
       t.bm_wrong_taxes,
       coalesce(t.agent_no_service, 0) as agent_no_service,
       coalesce(t.unprovable, 0) as unprovable,
       t.unverified_taxes,
       coalesce(t.name_matched_accounts, 0) as name_matched_accounts,
       b.bm_agent_seen_at,

       coalesce(t.does_payroll, false)     as does_payroll,
       coalesce(t.does_vat, false)         as does_vat,
       coalesce(t.does_accounts_ct, false) as does_accounts_ct,
       coalesce(t.does_sa, false)          as does_sa,
       (sf.entity_id is not null)          as does_software,

       (bp.entity_id is not null) as has_brightpay,
       bp.brightpay_employer,
       coalesce(bp.brightpay_active, false) as brightpay_active,
       (coalesce(t.does_payroll, false) and bp.entity_id is null) as payroll_not_on_brightpay,
       (bp.entity_id is not null and not coalesce(t.does_payroll, false)) as brightpay_without_payroll_service,

       b.taxcalc_accounts_seen_at, b.taxcalc_tax_return_seen_at,
       case when b.taxcalc_accounts_seen_at is null and b.taxcalc_tax_return_seen_at is null
            then null
            else (coalesce(t.does_accounts_ct,false) and b.taxcalc_accounts_seen_at is null)
              or (coalesce(t.does_sa,false)          and b.taxcalc_tax_return_seen_at is null)
       end as missing_from_taxcalc,

       coalesce(q.has_qbo, false) as has_qbo,
       (sf.entity_id is not null and not coalesce(q.has_qbo, false)) as software_without_qbo,

       (coalesce(t.does_vat,false)         and nullif(btrim(b.vat_number),'') is null)   as vat_service_no_vrn,
       (coalesce(t.does_payroll,false)     and nullif(btrim(b.paye_ref),'') is null)     as payroll_no_paye_ref,
       (coalesce(t.does_accounts_ct,false) and nullif(btrim(b.utr),'') is null)          as accounts_no_utr,
       (b.entity_type = 'limited_company'  and nullif(btrim(b.ch_auth_code),'') is null) as company_no_ch_auth_code,

       (ba.entity_id is null) as not_billed,
       coalesce(p.portal_claimed, false) as portal_claimed,
       coalesce(p.portal_invites, 0) as portal_invites
  from base b
  left join ob     o  on o.entity_id  = b.entity_id
  left join loe    l  on l.onboarding_id = o.onboarding_id
  left join tax    t  on t.entity_id  = b.entity_id
  left join bp        on bp.entity_id = b.entity_id
  left join qbo    q  on q.entity_id  = b.entity_id
  left join soft   sf on sf.entity_id = b.entity_id
  left join billed_any ba on ba.entity_id = b.entity_id
  left join portal p  on p.entity_id  = b.entity_id
 where is_staff_or_service();

comment on view v_onboarding_crosscheck_client is 'One row per active client: engagement-letter evidence (close-out ticks excluded), per-tax authorisation counts, name_matched_accounts for HMRC links resting on a name, and the BrightPay / TaxCalc / QuickBooks / references set-up checks behind the onboarding board verdict.';
grant select on v_onboarding_crosscheck_client to authenticated, service_role;
revoke all on v_onboarding_crosscheck_client from public;
revoke all on v_onboarding_crosscheck_client from anon;

create or replace view v_onboarding_crosscheck_board as
select c.*,
       case
         when c.has_onboarding and not c.loe_signed then 'keep_on_board'
         when c.missing_authorisations > 0                     then 'keep_on_board'
         when c.payroll_not_on_brightpay or c.software_without_qbo
           or c.vat_service_no_vrn or c.payroll_no_paye_ref or c.accounts_no_utr
           or coalesce(c.missing_from_taxcalc, false)          then 'not_set_up'
         when c.bm_disagreements > 0                           then 'fix_bm'
         when c.agent_no_service > 0                           then 'review_authorisation'
         -- not_billed deliberately does NOT drive a verdict: 337 active clients
         -- bill outside the fee engine and /manage/billing/gaps already owns
         -- that list. It stays on the row as context.
         when c.company_no_ch_auth_code                        then 'loose_end'
         else 'clean'
       end as verdict,
       case
         when (c.has_onboarding and not c.loe_signed) or c.missing_authorisations > 0 then 1
         when c.payroll_not_on_brightpay or c.software_without_qbo
           or c.vat_service_no_vrn or c.payroll_no_paye_ref or c.accounts_no_utr
           or coalesce(c.missing_from_taxcalc, false)          then 2
         when c.bm_disagreements > 0                           then 3
         when c.agent_no_service > 0                           then 4
         when c.company_no_ch_auth_code                        then 5
         else 9
       end as severity,
       (c.onboarding_status = 'complete'
         and (not c.loe_signed or c.missing_authorisations > 0)) as wrongly_closed,
       (c.has_onboarding and c.onboarding_status <> 'complete'
         and c.loe_signed and c.missing_authorisations = 0
         and not c.payroll_not_on_brightpay and not c.software_without_qbo
         and not c.vat_service_no_vrn and not c.payroll_no_paye_ref
         and not c.accounts_no_utr) as ready_to_close
  from v_onboarding_crosscheck_client c;

comment on view v_onboarding_crosscheck_board is 'The cross-check verdict per client: keep_on_board / not_set_up / fix_bm / review_authorisation / loose_end / clean, plus wrongly_closed (marked complete but unproven) and ready_to_close. not_billed is context only — the fee-engine gaps page owns that.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
