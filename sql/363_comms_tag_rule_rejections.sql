-- 363: Communications — let staff correct a wrong tag suggestion.
--
-- A suggestion comes from a learned sender→label rule (sql/153). When it's
-- wrong there was no way to say so: re-learning reinstates it from history,
-- and tagging the right label only ADDED a rule, so the inbox then suggested
-- both. A rejected rule is kept (not deleted) so merge_comms_tag_rules'
-- upsert can't silently bring it back; the inbox ignores it, including for
-- the company-domain fallback.
--
-- Writes: the comms-gmail edge function's reject_tag action (service role).
-- Tagging that sender with that label by hand again clears the flag — the
-- trigger keys on last_used_at, which only record_comms_tag moves, so a
-- history re-learn (which never touches last_used_at) can't un-reject.

alter table public.comms_tag_rules
  add column if not exists rejected boolean not null default false;

create or replace function public.comms_tag_rules_unreject()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.rejected and old.rejected and new.last_used_at > old.last_used_at then
    new.rejected := false;
  end if;
  return new;
end;
$$;

revoke execute on function public.comms_tag_rules_unreject() from public, anon, authenticated;

drop trigger if exists comms_tag_rules_unreject on public.comms_tag_rules;
create trigger comms_tag_rules_unreject
  before update on public.comms_tag_rules
  for each row execute function public.comms_tag_rules_unreject();
