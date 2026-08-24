-- 260: the contributor chooses who reads their feedback.
--
-- sql/184 built one lane: Bobby asks Tracy about Sophie, and Tracy's answer is
-- private to Bobby forever. Tried live on 2026-08-24 and two things broke down:
--
--   1. Tracy could not tell where her words were going. The UI said it, in grey,
--      under the box. She assumed she was writing to Sophie and wrote "test test"
--      rather than risk it.
--   2. There was no way to say the thing to Sophie's face. Feedback that can
--      only ever be given behind someone's back is a worse default than one
--      that offers the choice, and a manager cannot repeat it without becoming
--      the source.
--
-- So a contribution now carries a route, chosen by its author at the moment of
-- writing:
--
--   'requester'  (default)  the person who asked, only — sql/184's behaviour
--   'both'                  the asker and the subject
--   'subject'                the subject only; the asker never sees the text
--
-- The default stays 'requester', because that is what the asker asked for and
-- what every row written before today meant. Nothing already said in confidence
-- changes hands.

-- ── 1. The route ────────────────────────────────────────────────────────────

alter table public.pd_prep_contributions
  add column if not exists visibility text not null default 'requester';

do $$
begin
  alter table public.pd_prep_contributions
    add constraint pd_prep_contrib_visibility_chk
    check (visibility in ('requester', 'both', 'subject'));
exception when duplicate_object then null;
end $$;

-- Mirrored onto the request so the asker learns the route without seeing the
-- text: a 'subject' answer shows as answered-and-sent-direct, not as silence.
alter table public.pd_prep_feedback_requests
  add column if not exists answer_route text;

do $$
begin
  alter table public.pd_prep_feedback_requests
    add constraint pd_prep_fr_answer_route_chk
    check (answer_route is null or answer_route in ('requester', 'both', 'subject'));
exception when duplicate_object then null;
end $$;

-- ── 2. RLS follows the route ────────────────────────────────────────────────
-- The author always sees their own words. The asker sees them unless they were
-- addressed to the subject alone. The subject sees them only when the author
-- said so — the sql/184 default still hides the subject entirely.

drop policy if exists pd_prep_contrib_select on public.pd_prep_contributions;
create policy pd_prep_contrib_select on public.pd_prep_contributions
  for select using (
    contributor_id = auth.uid()
    or (requester_id = auth.uid() and visibility in ('requester', 'both'))
    or (subject_id   = auth.uid() and visibility in ('both', 'subject'))
  );

-- Insert is unchanged in shape, but pin the route to the author: without this a
-- contributor could write a row that hides itself from the person who asked
-- while claiming any requester_id it liked.
drop policy if exists pd_prep_contrib_insert on public.pd_prep_contributions;
create policy pd_prep_contrib_insert on public.pd_prep_contributions
  for insert with check (contributor_id = auth.uid() and public.is_active_staff());

-- The author may reword their own contribution but not re-route it after the
-- fact — pulling a line back out of the subject's view once they have read it
-- is theatre, and widening it later should be a fresh contribution.
create or replace function public.pd_prep_contrib_route_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.visibility is distinct from old.visibility then
    raise exception 'A contribution''s audience is fixed when it is written (was %, tried %)',
      old.visibility, new.visibility
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists pd_prep_contrib_route_immutable on public.pd_prep_contributions;
create trigger pd_prep_contrib_route_immutable
  before update on public.pd_prep_contributions
  for each row execute function public.pd_prep_contrib_route_is_immutable();

-- ── 3. Notifications follow the route too ───────────────────────────────────
-- One insert can now warrant two notifications with different words: the asker
-- is told input arrived on someone else, the subject is told a colleague shared
-- feedback with them. Neither is told about the other recipient's copy.

create or replace function public.pd_prep_notify_contribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contributor text;
  v_subject     text;
  v_route       text := coalesce(new.visibility, 'requester');
begin
  select name into v_contributor from staff_profiles where id = new.contributor_id;
  select name into v_subject     from staff_profiles where id = new.subject_id;

  if v_route in ('requester', 'both') then
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    values (
      new.requester_id,
      'prep_feedback_given',
      coalesce(v_contributor, 'A colleague') || ' added input on ' || coalesce(v_subject, 'a colleague'),
      left(new.body, 180),
      '/team/pd/prep',
      'prep_contrib:' || new.id::text
    );
  end if;

  if v_route in ('both', 'subject') then
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    values (
      new.subject_id,
      'prep_feedback_shared',
      coalesce(v_contributor, 'A colleague') || ' shared feedback with you',
      left(new.body, 180),
      '/team/pd',
      'prep_contrib_subj:' || new.id::text
    );
  end if;

  -- Tell the asker which way it went, without telling them what was said.
  if new.request_id is not null then
    update pd_prep_feedback_requests
       set answer_route = v_route
     where id = new.request_id;
  end if;

  return new;
end;
$$;

drop trigger if exists pd_prep_notify_contribution on public.pd_prep_contributions;
create trigger pd_prep_notify_contribution
  after insert on public.pd_prep_contributions
  for each row execute function public.pd_prep_notify_contribution();

-- ── 4. The ask links to the ask ─────────────────────────────────────────────
-- Tracy's notification dropped her on the prep page with its own default
-- selection showing — a page about somebody else entirely, with the request in
-- a panel she had to notice. The link now names the request, and the page opens
-- on it. The body says where a reply goes, because that was the other half of
-- what she could not tell.

create or replace function public.pd_prep_notify_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester text;
  v_subject   text;
begin
  select name into v_requester from staff_profiles where id = new.requester_id;
  select name into v_subject   from staff_profiles where id = new.subject_id;
  insert into notifications (recipient_id, kind, title, body, link_path, source_key)
  values (
    new.responder_id,
    'prep_feedback_request',
    coalesce(v_requester, 'A colleague') || ' asked for your input on ' || coalesce(v_subject, 'a colleague'),
    coalesce(new.message || ' — ', '')
      || 'Your reply goes to ' || coalesce(v_requester, 'them')
      || ', not to ' || coalesce(v_subject, 'the person it is about')
      || '. You can choose to copy them in when you write it.',
    '/team/pd/prep?request=' || new.id::text,
    'prep_fr:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists pd_prep_notify_request on public.pd_prep_feedback_requests;
create trigger pd_prep_notify_request
  after insert on public.pd_prep_feedback_requests
  for each row execute function public.pd_prep_notify_request();

comment on column public.pd_prep_contributions.visibility is
  'Who the author addressed this to: requester (default, private to the asker), '
  'both, or subject (the asker never sees the text). Fixed at write time.';
comment on column public.pd_prep_feedback_requests.answer_route is
  'How the answer was routed, so the asker can tell a direct-to-subject reply '
  'from an unanswered ask. Set by trigger, not by the client.';
