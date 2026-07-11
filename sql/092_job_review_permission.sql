-- Dedicated permission for the Job Review module so it can be granted per
-- staff member on the admin page (previously it piggy-backed on work_planner).
-- Seed = on for all currently-active staff so the team keeps access; new
-- staff default off and are granted explicitly.
alter table staff_profiles
  add column if not exists can_view_job_review boolean not null default false;

update staff_profiles
  set can_view_job_review = true
  where is_active is not false;

comment on column staff_profiles.can_view_job_review is
  'Grants access to the Job Review module (/review).';
