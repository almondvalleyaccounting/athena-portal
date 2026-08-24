-- 256: A wrong VAT number is not a missing authorisation.
--
-- Bobby spotted that hmrc.vat_client held exactly 100 rows and suspected a
-- pagination bug. There is no page to paginate — the Agent Services Account
-- has no client list, so the VAT scrape asks HMRC about each Athena VAT number
-- one at a time. The suspiciously round 100 is a coincidence, but the 26-client
-- gap it prompted us to dissect is real, and almost none of it is missing
-- authorisation:
--
--   * VAT numbers that fail the UK checksum. They cannot be real
--     registrations; the scraper refuses to ask HMRC about them (a malformed
--     number returns a page naming nobody). Desk-fixable in BM/Athena.
--   * VAT numbers HMRC says belong to a DIFFERENT business. The scraper
--     refuses to read those accounts, and the 2026-08-10 run's identity
--     reviews were worked — 7 confirmed as trading names of the same client
--     (hmrc.identity_alias), 3 investigated as genuinely wrong numbers, with
--     the findings written up and then never actioned or shown anywhere:
--     Connor Steven holds CS Abode Architects' number, Philip McMurray holds
--     Silver Cloud Travel's, Joan McLaughlin's is a mis-keying of Jo's 2 Go's.
--   * The 7 aliased clients just need the next VAT run to verify — their
--     identity question is settled.
--
-- All of these previously rendered as "not authorised", which is the wrong
-- story and the wrong to-do list. New per-tax verdicts:
--
--   invalid_reference    the number fails its own checksum — fix the record
--   reference_disputed   HMRC names another business — fix the record
--   (aliased → unverified with the confirmation named — wait for the run)
--
-- and a board verdict fix_reference for the first two: provable data errors,
-- fixable at the desk with no HMRC contact.

-- The UK VAT checksum, exactly as the scraper implements it
-- (HMRC-Scraper src/parse/vat.js isValidVatNumber): 9 digits, first seven
-- weighted 8..2, plus the last two as a number; valid when the total is
-- divisible by 97 (old style) or is after adding 55 (the 9755 style).
create or replace function public.is_valid_vat_number(v text)
returns boolean
language sql
immutable
as $$
  select case
    when d ~ '^[0-9]{9}$' then
      (( substr(d,1,1)::int * 8 + substr(d,2,1)::int * 7 + substr(d,3,1)::int * 6
       + substr(d,4,1)::int * 5 + substr(d,5,1)::int * 4 + substr(d,6,1)::int * 3
       + substr(d,7,1)::int * 2 + substr(d,8,2)::int ) % 97 = 0)
      or
      (( substr(d,1,1)::int * 8 + substr(d,2,1)::int * 7 + substr(d,3,1)::int * 6
       + substr(d,4,1)::int * 5 + substr(d,5,1)::int * 4 + substr(d,6,1)::int * 3
       + substr(d,7,1)::int * 2 + substr(d,8,2)::int + 55 ) % 97 = 0)
    else false
  end
  from (select regexp_replace(coalesce(v,''), '\D', '', 'g') as d) x
$$;

comment on function public.is_valid_vat_number(text) is 'UK VAT registration checksum (both the classic and 9755 variants), mirroring the scraper''s isValidVatNumber. Pure arithmetic — a number that fails this cannot be a real registration.';
revoke all on function public.is_valid_vat_number(text) from public;
revoke all on function public.is_valid_vat_number(text) from anon;
grant execute on function public.is_valid_vat_number(text) to authenticated, service_role;

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
   -- Only an onboarding IN FLIGHT can claim a service on a flag alone: that is
   -- the Velvet Rogue case, waiting on a number. Once the onboarding is
   -- complete the flag is history, not intent — the fee, BM's schedule or the
   -- reference itself must carry the claim from there. Hashtag Rose sat
   -- "awaiting registration" for VAT and PAYE it has never had, off flags the
   -- 2026-07-12 tracker import seeded onto an onboarding completed that same
   -- day; 66 rows read the same way.
   where o.archived_at is null
     and o.status in ('active','on_hold','issues')
     and c.cond in ('ct','sa','vat','paye','cis')
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
         when c.we_do and not c.hmrc_agent and rf.flag = 'invalid' then 'invalid_reference'
         when c.we_do and not c.hmrc_agent and rf.flag = 'disputed' then 'reference_disputed'
         when c.we_do and not c.hmrc_agent and rf.flag = 'aliased' then 'unverified'
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
         when c.we_do and not c.hmrc_agent and rf.flag is not null then rf.note
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
       end as verdict_detail,
       rf.flag as ref_flag,
       rf.note as ref_note
  from combined c
  join coverage cv on cv.tax = c.tax
  left join lateral (
    select o2.id, o2.status, o2.completed_at
      from onboardings o2
     where o2.entity_id = c.entity_id and o2.archived_at is null
     order by o2.created_at desc limit 1
  ) o on true
  -- The state of the VAT reference itself, when HMRC has NOT confirmed the
  -- client (a working scrape settles the question). Three states:
  --   invalid   fails the UK checksum — cannot be a real registration
  --   disputed  HMRC names a different business for this number, and the
  --             identity review judged it genuinely wrong (no alias)
  --   aliased   the review confirmed it is the same client under a trading
  --             name — the next VAT run verifies the authorisation
  left join lateral (
    select case
             when c.tax <> 'vat' or c.hmrc_agent then null
             when nullif(btrim(e2.vat_number),'') is null then null
             when not is_valid_vat_number(e2.vat_number) then 'invalid'
             when al.reference is not null then 'aliased'
             when ir.reference is not null then 'disputed'
           end as flag,
           case
             when c.tax <> 'vat' or c.hmrc_agent then null
             when nullif(btrim(e2.vat_number),'') is null then null
             when not is_valid_vat_number(e2.vat_number)
               then 'The VAT number ' || e2.vat_number || ' fails the UK VAT checksum — it cannot be a real registration. Fix the number in BM / Athena; HMRC was deliberately not asked about it.'
             when al.reference is not null
               then 'Identity confirmed: HMRC calls this client "' || al.hmrc_name || '". The next VAT run verifies the authorisation.'
             when ir.reference is not null
               then 'HMRC says this number belongs to "' || ir.hmrc_name || '". Review note: ' || ir.athena_name
           end as note
      from entities e2
      left join hmrc.identity_alias al
        on al.service = 'vat'
       and regexp_replace(al.reference, '\D', '', 'g')
         = regexp_replace(coalesce(e2.vat_number,''), '\D', '', 'g')
      left join lateral (
        select r.reference, r.hmrc_name, r.athena_name
          from hmrc.identity_review r
         where r.service = 'vat'
           and regexp_replace(r.reference, '\D', '', 'g')
             = regexp_replace(coalesce(e2.vat_number,''), '\D', '', 'g')
         order by r.last_seen desc limit 1
      ) ir on true
     where e2.id = c.entity_id
  ) rf on true
 where is_staff_or_service();

-- ── The client roll-up: BM's LOE date is only "stale Athena" when Athena has
--    a step to be stale against ─────────────────────────────────────────────
-- The first BM export with the engagement-letter column landed 2026-08-21 and
-- put a date on 593 clients. 503 of them have no onboarding record at all —
-- for them, BrightManager holding the date IS the record, complete and
-- correct. loe_from_bm_only used to fire anyway and drowned the loose-end
-- verdict (9 → 406). It now requires an onboarding whose step was never
-- ticked, which is the only reading where "Athena is stale" means anything.
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
         count(*) filter (where verdict in ('invalid_reference','reference_disputed')) as fix_references,
         max(ref_flag) filter (where tax = 'vat') as vat_ref_flag,
         max(ref_note) filter (where tax = 'vat') as vat_ref_note,
         bool_or(we_do and tax = 'paye')  as does_payroll,
         bool_or(we_do and tax = 'vat')   as does_vat,
         bool_or(we_do and tax = 'ct')    as does_accounts_ct,
         bool_or(we_do and tax = 'sa')    as does_sa
    from v_onboarding_crosscheck
   group by entity_id
),
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

       (coalesce(l.step_signed, false) or b.loe_signed_date is not null) as loe_signed,
       coalesce(l.step_signed_at, b.loe_signed_date::timestamptz) as loe_signed_at,
       coalesce(l.loe_closed_out, false) as loe_closed_out,
       -- Stale only against an existing checklist: BM has the date AND Athena
       -- has an onboarding whose step nobody ticked.
       (b.loe_signed_date is not null
         and o.onboarding_id is not null
         and not coalesce(l.step_signed, false)) as loe_from_bm_only,
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
            then null
            else (coalesce(t.does_accounts_ct,false) and b.taxcalc_accounts_seen_at is null)
              or (coalesce(t.does_sa,false)          and b.taxcalc_tax_return_seen_at is null)
       end as missing_from_taxcalc,

       coalesce(q.has_qbo, false) as has_qbo,
       (sf.entity_id is not null and not coalesce(q.has_qbo, false)) as software_without_qbo,

       (bv.entity_id is not null and not coalesce(t.does_vat, false)) as billed_vat_not_registered,
       (b.entity_type = 'limited_company' and nullif(btrim(b.ch_auth_code),'') is null) as company_no_ch_auth_code,

       (ba.entity_id is null) as not_billed,
       coalesce(p.portal_claimed, false) as portal_claimed,
       coalesce(p.portal_invites, 0) as portal_invites,
       -- appended, so create-or-replace does not have to reorder columns
       coalesce(t.fix_references, 0) as fix_references,
       t.vat_ref_flag,
       t.vat_ref_note
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

comment on view v_onboarding_crosscheck_client is 'One row per active client. fix_references counts VAT numbers that fail their checksum or that HMRC attributes to a different business — desk-fixable data errors, not missing authorisations. loe_signed accepts either record (Athena step ticked by a person, or BM signed date); loe_from_bm_only fires only when an onboarding exists whose step was never ticked. Reference-missing states count as awaiting_registration; billed_vat_not_registered flags a VAT product sold to a client with no VAT registration.';
grant select on v_onboarding_crosscheck_client to authenticated, service_role;
revoke all on v_onboarding_crosscheck_client from public;
revoke all on v_onboarding_crosscheck_client from anon;

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
         when c.fix_references > 0                                then 'fix_reference'
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
         when c.fix_references > 0                                then 3
         when c.bm_disagreements > 0                              then 4
         when c.billed_vat_not_registered or c.billed_ct_not_a_company
           or c.payroll_unbilled                                  then 5
         when c.agent_no_service > 0                              then 6
         when c.company_no_ch_auth_code or c.loe_from_bm_only
           or c.directors_sa_no_utr > 0                           then 7
         when c.awaiting_registration > 0                         then 8
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
         and c.awaiting_registration = 0
         and c.fix_references = 0) as ready_to_close
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

comment on view v_onboarding_crosscheck_board is 'The verdict per client (fix_reference = a VAT number failing its checksum or attributed by HMRC to another business — desk-fixable): keep_on_board / not_set_up / fix_bm / check_billing / review_authorisation / loose_end / awaiting_registration / clean, plus wrongly_closed and ready_to_close. Directors Self Assessment is resolved per director (see v_onboarding_crosscheck_director_sa): a director with no UTR is a loose end to capture, one HMRC has never authorised us for is a missing authorisation. Carries its own is_staff_or_service() predicate because it reads entities directly.';
grant select on v_onboarding_crosscheck_board to authenticated, service_role;
revoke all on v_onboarding_crosscheck_board from public;
revoke all on v_onboarding_crosscheck_board from anon;
