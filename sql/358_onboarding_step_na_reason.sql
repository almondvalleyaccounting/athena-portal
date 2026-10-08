-- Onboarding: "Already in place" as a kind of N/A.
--
-- A step that needs no work is N/A either because the client doesn't need it
-- (no VAT) or because it already exists (the director is already one of our
-- SA clients, so there is nothing to set up). Both take the step out of the
-- work: the progress bar, the board, the chaser, the portal and every other
-- reader already treat status 'na' as "not applicable", so the distinction is
-- carried beside the status rather than as a new status every reader would
-- have to learn.
--
-- na_reason is only meaningful while status = 'na'; the CHECK keeps it from
-- outliving a status change made by any write path.

alter table public.onboarding_steps
  add column if not exists na_reason text;

alter table public.onboarding_steps
  drop constraint if exists onboarding_steps_na_reason_check;

alter table public.onboarding_steps
  add constraint onboarding_steps_na_reason_check
  check (
    na_reason is null
    or (status = 'na' and na_reason in ('not_needed', 'in_place'))
  );

-- Any write that moves a step off N/A (the services panel re-ticking a service,
-- the portal, an edge function) drops the reason with it, so no write path has
-- to know the column exists for the CHECK above to hold.
create or replace function public.onboarding_steps_clear_na_reason()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from 'na' then
    new.na_reason := null;
  end if;
  return new;
end;
$$;

revoke all on function public.onboarding_steps_clear_na_reason() from public, anon, authenticated;

drop trigger if exists onboarding_steps_clear_na_reason on public.onboarding_steps;
create trigger onboarding_steps_clear_na_reason
  before insert or update of status, na_reason on public.onboarding_steps
  for each row execute function public.onboarding_steps_clear_na_reason();
