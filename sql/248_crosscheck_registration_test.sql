-- 248: VAT is a registration question, not a billing question — and you cannot
-- be the authorised agent for a tax the client is not registered for.
--
-- Supersedes the view definitions in sql/243, 246 and 247 (same pattern as 239
-- superseding 234). Four corrections, all of them from Bobby reading the first
-- output and disbelieving it:
--
-- 1. Billing is not evidence of VAT registration.
--    The VAT rule was the pattern 'vat' over billed services, so anything with
--    "VAT" in the product name counted — including "(Not VAT Registered)".
--    Worse, the whole approach was wrong: 17 Degrees Magazine is billed
--    "Bookkeeping (VAT Registered)" and "Monthly Bookkeeping & VAT Returns"
--    while not being VAT registered at all.
--
--    A client is VAT registered when BM has the VAT service switched on, or
--    Athena's onboarding flags VAT as required, or they have a VAT number.
--    The billing rules for VAT are retired, and a VAT product sold to a client
--    who is not registered is reported as billed_vat_not_registered — a fee to
--    correct, in its own verdict, not an authorisation to chase.
--
-- 2. No reference means nothing to be authorised for.
--    Velvet Rogue has VAT flagged in onboarding and no VAT number yet: the
--    registration is in flight. Reading that as "authorisation missing" is
--    wrong, so a client with no reference on record now reads
--    awaiting_registration — 57 clients, in progress rather than failing.
--
-- 3. Coverage must only count clients that COULD be on the scraped list.
--    Once the 49 awaiting-VRN clients joined the VAT population, VAT coverage
--    fell to 57% and tripped the partial-scrape guard, quietly turning 25 real
--    VAT gaps into "unverified". The denominator now excludes them: VAT is 80%
--    and those 25 are reported.
--
-- 4. Set-up checks wait for the registration they depend on.
--    You cannot put a client on BrightPay without a PAYE scheme, or into
--    TaxCalc without a UTR. That alone moved 28 clients out of "not set up".

-- ── Retire the billing rules for VAT, with the reason on the row ─────────
update onboarding_crosscheck_service_rules
   set active = false,
       note = coalesce(note || ' — ', '')
              || 'RETIRED 2026-08-20: billing is not evidence of VAT registration. Registration comes from the BM service, the onboarding flag, or a VAT number.'
 where source = 'billing' and tax = 'vat';

-- ── The per-tax cross-check ──────────────────────────────────────────────
drop view if exists v_onboarding_crosscheck cascade;
create view v_onboarding_crosscheck as
with scope as (
  select e.id as entity_id, e.name as entity_name, e.type as entity_type,
         e.bm_agent_sa, e.bm_agent_ct, e.bm_agent_vat, e.bm_agent_paye,
         e.bm_agent_cis, e.bm_agent_seen_at
    from entities e
   where e.entity_status = 'active'
),
-- The committed fee. Still a signal for the other taxes; never for VAT, whose
-- billing rules are retired above.
billed as (
  select distinct lb.entity_id, r.tax
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'billing' and (s->>'service_id') ~* r.pattern
     and (r.exclude_pattern is null or (s->>'service_id') !~* r.exclude_pattern)
   where coalesce(lb.status, '') <> 'cancelled'
),
-- The work BrightManager actually has scheduled.
scheduled as (
  select distinct b.entity_id, r.tax
    from bm_task_schedule b
    join onboarding_crosscheck_service_rules r
      on r.active and r.source = 'bm_task' and b.service ~* r.pattern
     and (r.exclude_pattern is null or b.service !~* r.exclude_pattern)
   where b.excluded_at is null
),
-- What Athena's onboarding says the client needs, plus a VAT number as proof of
-- VAT registration in its own right.
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
-- Is the client registered for the tax at all? Nothing can be authorised
-- before the reference exists.
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
-- Hard evidence, resolved on the identity key each tax has rather than on the
-- scraper's stored link — a name is a label, not an identity. See sql/246.
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
),
-- Coverage counts only clients that COULD be on the scraped list.
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

comment on view v_onboarding_crosscheck is 'Per client per tax: whether we act (BM scheduled work, onboarding service flags, VAT number, plus the committed fee for taxes other than VAT), what BM says about agent authorisation, and what the HMRC scrape proves. VAT registration never comes from billing. No reference on record reads awaiting_registration. Coverage counts only clients that could appear on the scraped list. Definer over the private hmrc schema; booleans and dates only.';
grant select on v_onboarding_crosscheck to authenticated, service_role;
revoke all on v_onboarding_crosscheck from public;
revoke all on v_onboarding_crosscheck from anon;

-- ── Is each leg's evidence good enough to conclude anything? ─────────────
create view v_onboarding_crosscheck_coverage as
select tax,
       count(*) filter (where we_do and registered is not false) as we_do_clients,
       count(*) filter (where hmrc_agent)                        as hmrc_clients,
       count(*) filter (where we_do and registered is false)     as awaiting_registration,
       max(coverage_ratio)                                       as coverage_ratio,
       bool_or(scrape_looks_partial)                             as scrape_looks_partial,
       max(hmrc_last_run)                                        as last_scrape
  from v_onboarding_crosscheck
 group by tax;

comment on view v_onboarding_crosscheck_coverage is 'Per tax: how many registered clients we act for, how many the HMRC scrape reached, how many are still awaiting a registration reference, and whether coverage is too thin to draw conclusions from.';
grant select on v_onboarding_crosscheck_coverage to authenticated, service_role;
revoke all on v_onboarding_crosscheck_coverage from public;
revoke all on v_onboarding_crosscheck_coverage from anon;

-- ── The client-level roll-up ─────────────────────────────────────────────
create or replace view v_onboarding_crosscheck_client as
with base as (
  select e.id as entity_id, e.name as entity_name, e.type as entity_type,
         e.utr, e.vat_number, e.paye_ref, e.ch_auth_code, e.loe_signed_date,
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
-- A step a person ticked counts. A step the Complete button ticked (sql/242)
-- does not — closing a client out must never launder itself into evidence.
loe as (
  select s.onboarding_id,
         bool_or(s.status = 'complete' and s.auto_completed_at is null) as step_signed,
         bool_or(s.auto_completed_at is not null)                        as loe_closed_out,
         max(s.completed_at) filter (where s.auto_completed_at is null)  as step_signed_at
    from onboarding_steps s
   where s.name ~* 'letter of engagement'
   group by s.onboarding_id
),
tax as (
  select entity_id,
         count(*) filter (where verdict = 'not_authorised')        as missing_authorisations,
         count(*) filter (where verdict = 'bm_wrong')              as bm_disagreements,
         count(*) filter (where verdict = 'agent_but_no_service')  as agent_no_service,
         count(*) filter (where verdict = 'awaiting_registration') as awaiting_registration,
         count(*) filter (where verdict in ('unverified','no_evidence')) as unprovable,
         count(*) filter (where hmrc_agent and hmrc_link_basis = 'name') as name_matched_accounts,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'not_authorised')        as unauthorised_taxes,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'bm_wrong')              as bm_wrong_taxes,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'unverified')            as unverified_taxes,
         string_agg(tax, ', ' order by tax) filter (where verdict = 'awaiting_registration') as awaiting_taxes,
         bool_or(we_do and tax = 'paye')  as does_payroll,
         bool_or(we_do and tax = 'vat')   as does_vat,
         bool_or(we_do and tax = 'ct')    as does_accounts_ct,
         bool_or(we_do and tax = 'sa')    as does_sa
    from v_onboarding_crosscheck
   group by entity_id
),
-- BrightPay via hmrc.brightpay_link (employer → entity by name, 119 of 127)
-- because v_wp_paye_readiness.has_brightpay is false for every client.
bp as (
  select l.entity_id, max(l.employer_name) as brightpay_employer,
         bool_or(coalesce(em.active, false)) as brightpay_active
    from hmrc.brightpay_link l
    left join payroll.employer em on em.id = l.employer_id
   where l.entity_id is not null
   group by l.entity_id
),
qbo as (select entity_id, has_qbo from v_wp_paye_readiness),
soft as (
  select distinct lb.entity_id
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
   where coalesce(lb.status,'') <> 'cancelled' and (s->>'service_id') ~* 'software'
),
-- Billed a VAT product while not VAT registered by any record. A fee question.
billed_vat as (
  select distinct lb.entity_id
    from live_billing lb
    cross join lateral jsonb_array_elements(lb.services) s
   where coalesce(lb.status,'') <> 'cancelled'
     and (s->>'service_id') ~* 'vat'
     and (s->>'service_id') !~* 'non.?vat|not vat'
),
billed_any as (
  select entity_id from live_billing where coalesce(status,'') <> 'cancelled' group by 1
),
portal as (
  select entity_id, bool_or(claimed_at is not null) as portal_claimed, count(*) as portal_invites
    from client_portal_invites group by 1
)
select b.entity_id, b.entity_name, b.entity_type,
       o.onboarding_id, o.onboarding_status, o.onboarding_completed_at, o.started_at,
       (o.onboarding_id is not null) as has_onboarding,

       -- Either record counts: Athena's step ticked by a person, or BM's date.
       -- Anchor Gas Services had the second without the first.
       (coalesce(l.step_signed, false) or b.loe_signed_date is not null) as loe_signed,
       coalesce(l.step_signed_at, b.loe_signed_date::timestamptz) as loe_signed_at,
       coalesce(l.loe_closed_out, false) as loe_closed_out,
       (b.loe_signed_date is not null and not coalesce(l.step_signed, false)) as loe_from_bm_only,
       b.loe_signed_date,

       coalesce(t.missing_authorisations, 0) as missing_authorisations,
       t.unauthorised_taxes,
       coalesce(t.bm_disagreements, 0) as bm_disagreements,
       t.bm_wrong_taxes,
       coalesce(t.agent_no_service, 0) as agent_no_service,
       coalesce(t.awaiting_registration, 0) as awaiting_registration,
       t.awaiting_taxes,
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
            then null                                  -- no feed yet, never a false "no"
            else (coalesce(t.does_accounts_ct,false) and b.taxcalc_accounts_seen_at is null)
              or (coalesce(t.does_sa,false)          and b.taxcalc_tax_return_seen_at is null)
       end as missing_from_taxcalc,

       coalesce(q.has_qbo, false) as has_qbo,
       (sf.entity_id is not null and not coalesce(q.has_qbo, false)) as software_without_qbo,

       (bv.entity_id is not null and not coalesce(t.does_vat, false)) as billed_vat_not_registered,
       (b.entity_type = 'limited_company' and nullif(btrim(b.ch_auth_code),'') is null) as company_no_ch_auth_code,

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
  left join billed_vat bv on bv.entity_id = b.entity_id
  left join billed_any ba on ba.entity_id = b.entity_id
  left join portal p  on p.entity_id  = b.entity_id
 where is_staff_or_service();

comment on view v_onboarding_crosscheck_client is 'One row per active client. loe_signed accepts either record (Athena step ticked by a person, or BM signed date). Reference-missing states are counted as awaiting_registration rather than failures. billed_vat_not_registered flags a VAT product sold to a client with no VAT registration.';
grant select on v_onboarding_crosscheck_client to authenticated, service_role;
revoke all on v_onboarding_crosscheck_client from public;
revoke all on v_onboarding_crosscheck_client from anon;

-- ── The verdict ──────────────────────────────────────────────────────────
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
         when c.billed_vat_not_registered                         then 'check_billing'
         when c.company_no_ch_auth_code or c.loe_from_bm_only     then 'loose_end'
         when c.awaiting_registration > 0                         then 'awaiting_registration'
         -- not_billed deliberately does NOT drive a verdict: 337 active clients
         -- bill outside the fee engine and /manage/billing/gaps owns that list.
         else 'clean'
       end as verdict,
       case
         when (c.has_onboarding and not c.loe_signed) or c.missing_authorisations > 0 then 1
         when (c.payroll_not_on_brightpay and c.paye_registered)
           or c.software_without_qbo
           or (coalesce(c.missing_from_taxcalc, false) and c.utr_registered) then 2
         when c.bm_disagreements > 0                              then 3
         when c.agent_no_service > 0                              then 4
         when c.billed_vat_not_registered                         then 5
         when c.company_no_ch_auth_code or c.loe_from_bm_only     then 6
         when c.awaiting_registration > 0                         then 7
         else 9
       end as severity,
       -- Marked complete but the evidence says otherwise: the reason this
       -- module exists.
       (c.onboarding_status = 'complete'
         and (not c.loe_signed or c.missing_authorisations > 0)) as wrongly_closed,
       (c.has_onboarding and c.onboarding_status <> 'complete'
         and c.loe_signed and c.missing_authorisations = 0
         and not (c.payroll_not_on_brightpay and c.paye_registered)
         and not c.software_without_qbo
         and c.awaiting_registration = 0) as ready_to_close
  from (
    -- You cannot put a client on BrightPay before they have a PAYE scheme, or
    -- into TaxCalc before they have a UTR. Velvet Rogue was flagged "payroll
    -- not on BrightPay" while still waiting for its PAYE reference.
    select cc.*,
           nullif(btrim(e.paye_ref),'') is not null as paye_registered,
           nullif(btrim(e.utr),'')      is not null as utr_registered
      from v_onboarding_crosscheck_client cc
      join entities e on e.id = cc.entity_id
     -- This view reads entities directly, so it carries its own predicate
     -- rather than leaning on the inner view's. The posture audit flagged the
     -- shape (definer view over a base table with no gate) even though the
     -- inner view meant no rows actually escaped — the shape is the bug.
     where is_staff_or_service()
  ) c;

comment on view v_onboarding_crosscheck_board is 'The verdict per client: keep_on_board / not_set_up / fix_bm / review_authorisation / check_billing / loose_end / awaiting_registration / clean, plus wrongly_closed and ready_to_close. Set-up checks (BrightPay, TaxCalc) only bite once the registration they depend on exists; awaiting_registration is a legitimate in-progress state. Carries its own is_staff_or_service() predicate because it reads entities directly. not_billed is context only.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
