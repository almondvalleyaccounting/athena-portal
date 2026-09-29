-- Onboarding priority: high rows always sit at the top of the Onboarding
-- list, whatever column it is sorted by. Set from the list's row menu or the
-- onboarding's header. Existing write path (staff update on onboardings under
-- its current RLS); no new grant, function or policy.
alter table public.onboardings
  add column if not exists priority text not null default 'normal'
  constraint onboardings_priority_check check (priority in ('high', 'normal', 'low'));
