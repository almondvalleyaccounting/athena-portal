-- 243: Onboarding cross-check — sense-check what we think against what the
-- other systems know.
--
-- The onboarding board records what we believe. Five other systems hold
-- evidence of whether it is true, and each one's silence means something:
--
--   BrightManager  — an agent-authorisation field per tax type (what we THINK)
--   HMRC scrape    — if we can scrape a client's account we ARE the authorised
--                    agent; if we can't, we are not. This is the hard evidence,
--                    and where it disagrees with BM, BM is the one that's wrong.
--   BrightPay      — payroll switched on with no BrightPay employer = not set up
--   TaxCalc        — accounts / CT600 / SA switched on with no TaxCalc client
--   QuickBooks     — software billed with no connected realm
--
-- No engagement letter, or no agent authorisation, means the client stays on
-- the onboarding board however complete the checklist looks.
--
-- Two feeds do not exist yet and their columns read null (= "no data", never
-- "no"):
--   * entities.bm_agent_* — the BM client export has agent fields per tax type
--     but the importer has never read them. Migration adds the columns; the
--     parser auto-detects the headers on the next import and reports which it
--     matched.
--   * entities.taxcalc_* — no TaxCalc import has ever run (the TaxCalc sources
--     in Data Import have no parser yet), so nothing in Athena knows which
--     clients exist in TaxCalc. The leg is built and waits for that feed.

-- ── What BrightManager thinks we are the agent for ───────────────────────
-- null = the column wasn't in the last import (unknown), not false.
alter table entities
  add column if not exists bm_agent_sa       boolean,
  add column if not exists bm_agent_ct       boolean,
  add column if not exists bm_agent_vat      boolean,
  add column if not exists bm_agent_paye     boolean,
  add column if not exists bm_agent_cis      boolean,
  add column if not exists bm_agent_seen_at  timestamptz,
  add column if not exists taxcalc_accounts_seen_at   timestamptz,
  add column if not exists taxcalc_tax_return_seen_at timestamptz;

comment on column entities.bm_agent_sa is 'BrightManager''s agent-authorisation flag for Self Assessment, from the client export. null = the export had no such column (unknown), not "not authorised".';
comment on column entities.bm_agent_seen_at is 'When an import last populated any bm_agent_* column. Stale or null means BM''s view is unverified.';
comment on column entities.taxcalc_accounts_seen_at is 'When this client was last seen in a TaxCalc Accounts export. null = no TaxCalc import has run.';
comment on column entities.taxcalc_tax_return_seen_at is 'When this client was last seen in a TaxCalc Tax Return export. null = no TaxCalc import has run.';

-- ── Which billed / scheduled services imply which tax authorisation ──────
-- A table rather than regexes buried in a view, so the mapping can be tuned
-- without a migration when the QBO catalogue or BM's service names change.
create table if not exists onboarding_crosscheck_service_rules (
  id      uuid primary key default gen_random_uuid(),
  source  text not null check (source in ('billing','bm_task')),
  pattern text not null,                 -- case-insensitive regex
  tax     text not null check (tax in ('ct','sa','vat','paye','cis','software','confirmation_statement')),
  note    text,
  active  boolean not null default true
);
comment on table onboarding_crosscheck_service_rules is 'Maps a live_billing service_id (source=billing) or a bm_task_schedule.service (source=bm_task) to the tax authorisation it implies. Drives v_onboarding_crosscheck.';

alter table onboarding_crosscheck_service_rules enable row level security;
drop policy if exists ocsr_staff_read on onboarding_crosscheck_service_rules;
create policy ocsr_staff_read on onboarding_crosscheck_service_rules
  for select to authenticated using (is_active_staff());
drop policy if exists ocsr_admin_write on onboarding_crosscheck_service_rules;
create policy ocsr_admin_write on onboarding_crosscheck_service_rules
  for all to authenticated
  using (exists (select 1 from staff_profiles where id = auth.uid() and is_active and can_manage_portal))
  with check (exists (select 1 from staff_profiles where id = auth.uid() and is_active and can_manage_portal));
grant select on onboarding_crosscheck_service_rules to authenticated, service_role;
revoke all on onboarding_crosscheck_service_rules from public;

insert into onboarding_crosscheck_service_rules (source, pattern, tax, note)
select * from (values
  -- Fee-engine / QBO catalogue names. live_billing.services holds the colon
  -- joined catalogue path, e.g. 'Accounts:Business Accounts and CT Combined'.
  ('billing', 'accounts|corporation tax|ct600|annual statutory|dormant',  'ct',   'accounts & CT work needs CT agent authorisation'),
  ('billing', 'tax returns|self assessment|personal tax',                 'sa',   'SA returns need SA agent authorisation'),
  ('billing', 'vat',                                                      'vat',  'includes Bookkeeping (VAT Registered)'),
  ('billing', 'payroll|auto.?enrol|pension',                              'paye', 'excluded below: Modulr is a payment rail, not payroll'),
  ('billing', 'cis',                                                      'cis',  null),
  ('billing', 'software',                                                 'software', 'implies a QuickBooks subscription we manage'),
  ('billing', 'confirmation statement',                                   'confirmation_statement', null),
  -- All Inclusive bundles name their contents in the line description, so the
  -- bundle itself implies accounts, CT, SA and (where VAT registered) VAT.
  ('billing', 'all inclusive',                                            'ct',   'bundle includes annual accounts and business tax'),
  ('billing', 'all inclusive',                                            'sa',   'bundle includes owners self assessment'),
  ('billing', 'all inclusive.*vat registered',                            'vat',  'VAT-registered bundle includes quarterly VAT returns'),

  -- BrightManager scheduled work — BM's own view of what we do for a client.
  ('bm_task', '^annual accounts$|^accounts$|^corporation tax$',           'ct',   null),
  ('bm_task', '^self assessment$|^personal tax$',                         'sa',   null),
  ('bm_task', '^vat$',                                                    'vat',  null),
  ('bm_task', '^payroll$|^pensions$',                                     'paye', null),
  ('bm_task', '^confirmation statement$',                                 'confirmation_statement', null)
) v(source, pattern, tax, note)
where not exists (select 1 from onboarding_crosscheck_service_rules);


-- ── The per-tax cross-check ──────────────────────────────────────────────
-- One row per (client, tax) where either we think we act, or HMRC shows us as
-- the agent. Definer, because it reads the private hmrc schema, and carries
-- its own predicate: active staff (the same audience as every other HMRC
-- view), plus service_role and no-JWT callers so a digest can run later.
-- It exposes booleans and dates only — no balances leave the hmrc schema here.
--
-- Two traps this had to be taught, both found by disbelieving the first run:
--
--   * A limited company never holds its own SA authorisation. "Directors' tax
--     return" is billed to the company but authorised on the director's
--     personal UTR — a different entity, with its own row here. Without the
--     exclusion, all 95 companies with directors' returns read as SA failures.
--   * A scrape that reached a third of the clients we act for is evidence the
--     scrape is incomplete, not that two thirds of the file is wrong. Below
--     60% coverage the rows say 'unverified' and name the coverage rather than
--     accusing anyone. That is the SA leg today: 89 of 299.
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
-- Hard evidence: the scrape only reaches accounts we are the authorised agent
-- for, so presence on a scraped list IS the authorisation.
hmrc_seen as (
  select entity_id, 'paye'::text as tax, max(last_seen) as hmrc_last_seen
    from hmrc.client where entity_id is not null group by 1
  union all
  select entity_id, 'vat', max(last_seen) from hmrc.vat_client where entity_id is not null group by 1
  union all
  select entity_id, 'sa', max(last_seen) from hmrc.sa_client where entity_id is not null group by 1
  union all
  select entity_id, 'ct', max(last_seen) from hmrc.ct_client where entity_id is not null group by 1
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
     and not (t.tax = 'sa' and s.entity_type = 'limited_company')
),
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

comment on view v_onboarding_crosscheck is 'Per client per tax: what we think we do (fee engine + BM scheduled work), what BrightManager says about agent authorisation, and what the HMRC scrape proves. Company SA rows are excluded (directors SA is authorised on the director entity). Where a scrape reached under 60% of the clients we act for, rows read unverified rather than not_authorised. Definer over the private hmrc schema; booleans and dates only.';
grant select on v_onboarding_crosscheck to authenticated, service_role;
revoke all on v_onboarding_crosscheck from public;
revoke all on v_onboarding_crosscheck from anon;

-- Is each leg's evidence good enough to draw conclusions from?
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

-- ── The client-level roll-up ─────────────────────────────────────────────
-- One row per active client: the engagement evidence, the per-system set-up
-- checks, and everything the verdict is built from.
--
-- Engagement letter: a step ticked by a person counts. A step ticked by the
-- onboarding-level Complete button (sql/242) does NOT — closing a client out
-- must never launder itself into evidence that the letter was signed.
--
-- BrightPay comes through hmrc.brightpay_link (employer → entity by name, 119
-- of 127 matched) rather than v_wp_paye_readiness.has_brightpay, which is
-- false for every client because that leg was never fed.
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

       -- Engagement
       coalesce(l.loe_signed, false) as loe_signed,
       l.loe_signed_at,
       coalesce(l.loe_closed_out, false) as loe_closed_out,

       -- Authorisation, from the per-tax view
       coalesce(t.missing_authorisations, 0) as missing_authorisations,
       t.unauthorised_taxes,
       coalesce(t.bm_disagreements, 0) as bm_disagreements,
       t.bm_wrong_taxes,
       coalesce(t.agent_no_service, 0) as agent_no_service,
       coalesce(t.unprovable, 0) as unprovable,
       t.unverified_taxes,
       b.bm_agent_seen_at,

       -- Services we believe are switched on
       coalesce(t.does_payroll, false)     as does_payroll,
       coalesce(t.does_vat, false)         as does_vat,
       coalesce(t.does_accounts_ct, false) as does_accounts_ct,
       coalesce(t.does_sa, false)          as does_sa,
       (sf.entity_id is not null)          as does_software,

       -- BrightPay
       (bp.entity_id is not null) as has_brightpay,
       bp.brightpay_employer,
       coalesce(bp.brightpay_active, false) as brightpay_active,
       (coalesce(t.does_payroll, false) and bp.entity_id is null) as payroll_not_on_brightpay,
       (bp.entity_id is not null and not coalesce(t.does_payroll, false)) as brightpay_without_payroll_service,

       -- TaxCalc (null until the TaxCalc feed exists — never a false "no")
       b.taxcalc_accounts_seen_at, b.taxcalc_tax_return_seen_at,
       case when b.taxcalc_accounts_seen_at is null and b.taxcalc_tax_return_seen_at is null
            then null
            else (coalesce(t.does_accounts_ct,false) and b.taxcalc_accounts_seen_at is null)
              or (coalesce(t.does_sa,false)          and b.taxcalc_tax_return_seen_at is null)
       end as missing_from_taxcalc,

       -- QuickBooks
       coalesce(q.has_qbo, false) as has_qbo,
       (sf.entity_id is not null and not coalesce(q.has_qbo, false)) as software_without_qbo,

       -- References the work cannot be done without
       (coalesce(t.does_vat,false)         and nullif(btrim(b.vat_number),'') is null)   as vat_service_no_vrn,
       (coalesce(t.does_payroll,false)     and nullif(btrim(b.paye_ref),'') is null)     as payroll_no_paye_ref,
       (coalesce(t.does_accounts_ct,false) and nullif(btrim(b.utr),'') is null)          as accounts_no_utr,
       (b.entity_type = 'limited_company'  and nullif(btrim(b.ch_auth_code),'') is null) as company_no_ch_auth_code,

       -- Commercials and access
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

comment on view v_onboarding_crosscheck_client is 'One row per active client: engagement-letter evidence (close-out ticks excluded), per-tax authorisation counts, and the BrightPay / TaxCalc / QuickBooks / references set-up checks behind the onboarding board verdict.';
grant select on v_onboarding_crosscheck_client to authenticated, service_role;
revoke all on v_onboarding_crosscheck_client from public;
revoke all on v_onboarding_crosscheck_client from anon;

-- ── The verdict ──────────────────────────────────────────────────────────
-- What to DO about each client, ordered by how much it matters.
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
       -- Marked complete but the evidence says otherwise: the reason this
       -- module exists.
       (c.onboarding_status = 'complete'
         and (not c.loe_signed or c.missing_authorisations > 0)) as wrongly_closed,
       -- Still on the board with nothing left to prove.
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

-- A payroll we run for someone the client list does not know about.
create or replace view v_onboarding_crosscheck_orphans as
select l.employer_id, l.employer_name, em.active as brightpay_active, em.pay_frequency
  from hmrc.brightpay_link l
  left join payroll.employer em on em.id = l.employer_id
 where l.entity_id is null and is_staff_or_service();

comment on view v_onboarding_crosscheck_orphans is 'BrightPay employers that match no client in Athena — a payroll we run for someone the client list does not know about, or a naming mismatch to fix.';
grant select on v_onboarding_crosscheck_orphans to authenticated, service_role;
revoke all on v_onboarding_crosscheck_orphans from public;
revoke all on v_onboarding_crosscheck_orphans from anon;
