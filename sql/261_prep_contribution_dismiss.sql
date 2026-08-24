-- 261: the asker can clear a contribution out of their prep, for real.
--
-- Reported 2026-08-24: "I tried to delete Tracy's test comments but the delete
-- didn't persist." It never could. sql/184 says the author's words stay the
-- author's — `pd_prep_contrib_delete` is `contributor_id = auth.uid()` — so the
-- DELETE the button fired matched zero rows. PostgREST answers a zero-row
-- delete with 204, the UI struck the row out of local state, and the illusion
-- lasted exactly until the next reload.
--
-- Both halves of that were wrong, in opposite directions: the rule is right
-- (nobody edits somebody else's feedback out of existence) and the button was
-- right too (a manager must be able to clear noise out of their own prep).
-- What was missing is the distinction between the two, so:
--
--   the author        deletes  — the words are gone, everywhere
--   the person who asked  dismisses — it leaves their prep, the row survives
--
-- and a dismissal is written down, so it survives a reload.

alter table public.pd_prep_contributions
  add column if not exists dismissed_at timestamptz;

comment on column public.pd_prep_contributions.dismissed_at is
  'Set by the requester to clear this out of their own prep. The row and its '
  'author''s copy survive — this is not a delete.';

-- The requester may now update the row, but only this one column. Postgres RLS
-- cannot say "these columns only", so the trigger below says it instead.
drop policy if exists pd_prep_contrib_update on public.pd_prep_contributions;
create policy pd_prep_contrib_update on public.pd_prep_contributions
  for update using (contributor_id = auth.uid() or requester_id = auth.uid())
  with check (contributor_id = auth.uid() or requester_id = auth.uid());

-- Guards two things at once now: the audience is fixed at write time (sql/260),
-- and a requester's update may touch nothing but dismissed_at. auth.uid() is
-- null for service_role and psql, which are left alone deliberately — the
-- importer and cron have no business here, but a fix-up by hand should work.
create or replace function public.pd_prep_contrib_route_is_immutable()
returns trigger
language plpgsql
as $$
declare
  v_uid uuid := auth.uid();
begin
  if new.visibility is distinct from old.visibility then
    raise exception 'A contribution''s audience is fixed when it is written (was %, tried %)',
      old.visibility, new.visibility
      using errcode = '42501';
  end if;

  if v_uid is not null and v_uid = old.requester_id and v_uid <> old.contributor_id then
    if new.body is distinct from old.body
       or new.kind is distinct from old.kind
       or new.contributor_id is distinct from old.contributor_id
       or new.subject_id is distinct from old.subject_id
       or new.requester_id is distinct from old.requester_id
       or new.request_id is distinct from old.request_id then
      raise exception 'You asked for this feedback, so you can clear it from your prep — but the words stay as written'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists pd_prep_contrib_route_immutable on public.pd_prep_contributions;
create trigger pd_prep_contrib_route_immutable
  before update on public.pd_prep_contributions
  for each row execute function public.pd_prep_contrib_route_is_immutable();
