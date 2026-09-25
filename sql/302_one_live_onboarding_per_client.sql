-- ============================================================
-- 302 — One live onboarding per client
--
-- United West Property had two runs from the same quote, 25 days apart; the
-- second was started over the first and later archived. The new-onboarding
-- screen only warned. Now the table refuses it.
--
-- "Live" = not archived and status in ('active','on_hold','issues') — the
-- same test activeOnboardingsForEntity() and the client page use. Archiving
-- leaves status alone, so archived_at is part of the test, not an extra.
--
-- A trigger rather than a partial unique index because PDNABC Ltd already
-- holds two live runs (12 Jul and 23 Sep 2026), which an index would refuse
-- to build over. Resolving that pair is a person's decision, not a
-- migration's. The trigger fires only when a row BECOMES live — an insert, or
-- an update that restores/reopens it — so those two keep working as they are,
-- and neither can be restored once archived while the other is live.
-- ============================================================

create or replace function public.onboardings_one_live_per_client()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  new_live boolean := new.archived_at is null and new.status in ('active', 'on_hold', 'issues');
  -- Moving a live run to another client counts as becoming live there.
  old_live boolean := tg_op = 'UPDATE' and old.entity_id = new.entity_id
    and old.archived_at is null and old.status in ('active', 'on_hold', 'issues');
begin
  if new_live and not old_live and exists (
    select 1 from public.onboardings o
    where o.entity_id = new.entity_id
      and o.id <> new.id
      and o.archived_at is null
      and o.status in ('active', 'on_hold', 'issues')
  ) then
    raise exception 'This client already has an onboarding in progress — finish or archive it before starting another'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

-- A trigger function is not callable as an RPC, but it is still a function in
-- public and picks up the schema default EXECUTE grant. Say what is true.
revoke all on function public.onboardings_one_live_per_client() from public, anon, authenticated;

drop trigger if exists onboardings_one_live_per_client on public.onboardings;
create trigger onboardings_one_live_per_client
  before insert or update of status, archived_at, entity_id on public.onboardings
  for each row execute function public.onboardings_one_live_per_client();
