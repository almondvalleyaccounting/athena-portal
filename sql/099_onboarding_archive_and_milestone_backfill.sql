-- 099: Onboarding archive support + milestone backfill
--
-- Two fixes for the onboarding module:
--
-- 1) Archive: a nullable timestamp. Archived onboardings drop off the List
--    and Board by default; an "Archived" filter tab surfaces them for restore.
--    Distinct from status so a 'complete' client keeps its meaning once filed.
alter table onboardings add column if not exists archived_at timestamptz;

-- 2) Milestone backfill. The Board only draws a cell when the per-client step
--    row has milestone=true. Neither the bulk import from Sophie's tracker
--    (12/07/2026, created_by null) nor createOnboarding() copied the flag from
--    the template, so every imported client rendered as blank cells. Sync each
--    live step's milestone flag from its linked template step. (createOnboarding
--    and addDirectorSa are fixed in code to carry the flag forward from now on.)
update onboarding_steps s
   set milestone = ts.milestone
  from onboarding_template_steps ts
 where s.template_step_id = ts.id
   and s.milestone is distinct from ts.milestone;
