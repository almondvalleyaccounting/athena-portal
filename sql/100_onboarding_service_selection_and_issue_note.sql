-- 100: Explicit service/registration selection + issue surfacing
--
-- Onboarding now carries an EDITABLE set of service conditions (what the
-- client actually takes) instead of only deriving them from a quote. This
-- drives which conditional step groups apply, which handover areas exist
-- (the "task owner" tiles) and which 3-month check-in tiles show. Imported
-- clients had no quote, so conditions were previously unresolved — hence VAT
-- returns showing for non-VAT clients.

-- 1) Authoritative set of active service conditions on the onboarding.
--    Keys match onboarding_template_steps.service_condition
--    (sa, ct, vat, paye, cis, software, confirmation_statement).
alter table onboardings add column if not exists service_conditions text[];

-- 2) A short, editable reason shown when status = 'issues' (tile hover +
--    detail banner). The import buried this in the free-text notes blob.
alter table onboardings add column if not exists issue_note text;

-- 3) Denormalise the template step's service_condition onto the live step so
--    the UI can flip a whole condition's incomplete steps na<->to-do without
--    re-reading the template.
alter table onboarding_steps add column if not exists service_condition text;
update onboarding_steps s
   set service_condition = ts.service_condition
  from onboarding_template_steps ts
 where ts.id = s.template_step_id
   and s.service_condition is distinct from ts.service_condition;

-- 4) Denormalise the handover area's condition so the panel/check-in can
--    filter areas by the onboarding's service_conditions.
alter table onboarding_handovers add column if not exists service_condition text;
update onboarding_handovers h
   set service_condition = d.service_condition
  from onboarding_handover_defaults d
 where d.area = h.area
   and h.service_condition is null;

-- 5) Backfill service_conditions from reality: a condition is active when the
--    onboarding has at least one non-na step for it. Uniform for quote-based
--    (resolveSteps already na'd unmet conditions) and imported clients (import
--    set na from the tracker).
update onboardings o
   set service_conditions = sub.conds
  from (
    select s.onboarding_id, array_agg(distinct s.service_condition) as conds
      from onboarding_steps s
     where s.service_condition is not null and s.status <> 'na'
     group by s.onboarding_id
  ) sub
 where sub.onboarding_id = o.id
   and o.service_conditions is null;

-- Onboardings with no active conditional step get an explicit empty set
-- (distinct from null = never computed) so the panel/handovers treat them as
-- "no services selected yet" rather than falling back to "show everything".
update onboardings set service_conditions = '{}' where service_conditions is null;

-- 6) Backfill the issue reason for 'issues' clients from the tracker text.
--    Prefer the "Open issue:" line, else the "Issue tracker note:" tag.
update onboardings
   set issue_note = nullif(trim(coalesce(
         substring(notes from 'Open issue:\s*([^\n]*)'),
         substring(notes from 'Issue tracker note:\s*([^\n]*)')
       )), '')
 where status = 'issues'
   and issue_note is null;
