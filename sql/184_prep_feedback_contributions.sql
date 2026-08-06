-- 184: Ask colleagues to contribute to my private 1-2-1 prep notes.
--
-- The ask (Bobby, 2026-08-06): "let me ask Tracy to give me feedback for
-- Sophie". Feedback given TO ME, for my prep — not a 360 the subject reads.
--
-- Three-party privacy model, and it matters:
--   requester   (Bobby)  sees his own notes + every contribution he asked for
--   contributor (Tracy)  sees the request, and only her own contributions
--   subject     (Sophie) sees NOTHING — no request, no contribution, no hint
-- Tracy never sees Bobby's own prep notes, and never sees what other
-- contributors wrote. Each lane is enforced by RLS, not by the UI.
--
-- This is deliberately NOT pd_feedback_requests (sql/096). That flow is the
-- opposite shape: the SUBJECT asks for feedback and the answer posts as an
-- attributed comment the subject reads. Same word, inverted visibility — so
-- they stay separate tables.
--
-- Companion to sql/183 (pd_prep_notes).

-- ── 1. The request ──────────────────────────────────────────────────────────

create table if not exists public.pd_prep_feedback_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references public.staff_profiles(id) on delete cascade,
  subject_id    uuid not null references public.staff_profiles(id) on delete cascade,
  responder_id  uuid not null references public.staff_profiles(id) on delete cascade,
  message       text,
  status        text not null default 'open' check (status in ('open', 'answered', 'declined')),
  responded_at  timestamptz,
  created_at    timestamptz not null default now(),
  -- Asking the subject for input on themselves would tell them the exercise
  -- exists. The whole point is third-party input, so block it outright.
  constraint pd_prep_fr_responder_not_subject check (responder_id <> subject_id)
);

create index if not exists pd_prep_fr_responder_idx
  on public.pd_prep_feedback_requests (responder_id, status, created_at desc);
create index if not exists pd_prep_fr_requester_idx
  on public.pd_prep_feedback_requests (requester_id, subject_id, created_at desc);

-- ── 2. The contribution ─────────────────────────────────────────────────────

create table if not exists public.pd_prep_contributions (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid references public.pd_prep_feedback_requests(id) on delete set null,
  requester_id   uuid not null references public.staff_profiles(id) on delete cascade,
  subject_id     uuid not null references public.staff_profiles(id) on delete cascade,
  contributor_id uuid not null references public.staff_profiles(id) on delete cascade,
  kind           text not null default 'work' check (kind in ('work', 'development')),
  body           text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists pd_prep_contrib_requester_idx
  on public.pd_prep_contributions (requester_id, subject_id, created_at desc);
create index if not exists pd_prep_contrib_contributor_idx
  on public.pd_prep_contributions (contributor_id, created_at desc);

drop trigger if exists pd_prep_contributions_touch on public.pd_prep_contributions;
create trigger pd_prep_contributions_touch
  before update on public.pd_prep_contributions
  for each row execute function public.pd_prep_notes_touch();

-- ── 3. RLS ──────────────────────────────────────────────────────────────────

alter table public.pd_prep_feedback_requests enable row level security;

-- Both ends of the ask can see it. The subject is not an end.
drop policy if exists pd_prep_fr_select on public.pd_prep_feedback_requests;
create policy pd_prep_fr_select on public.pd_prep_feedback_requests
  for select using (requester_id = auth.uid() or responder_id = auth.uid());

drop policy if exists pd_prep_fr_insert on public.pd_prep_feedback_requests;
create policy pd_prep_fr_insert on public.pd_prep_feedback_requests
  for insert with check (requester_id = auth.uid() and public.is_active_staff());

-- Responder answers/declines; requester can reopen or tidy up.
drop policy if exists pd_prep_fr_update on public.pd_prep_feedback_requests;
create policy pd_prep_fr_update on public.pd_prep_feedback_requests
  for update using (requester_id = auth.uid() or responder_id = auth.uid())
  with check (requester_id = auth.uid() or responder_id = auth.uid());

drop policy if exists pd_prep_fr_delete on public.pd_prep_feedback_requests;
create policy pd_prep_fr_delete on public.pd_prep_feedback_requests
  for delete using (requester_id = auth.uid());

alter table public.pd_prep_contributions enable row level security;

-- The person who asked, and the person who wrote it. Nobody else — in
-- particular not the subject, and not other contributors.
drop policy if exists pd_prep_contrib_select on public.pd_prep_contributions;
create policy pd_prep_contrib_select on public.pd_prep_contributions
  for select using (requester_id = auth.uid() or contributor_id = auth.uid());

drop policy if exists pd_prep_contrib_insert on public.pd_prep_contributions;
create policy pd_prep_contrib_insert on public.pd_prep_contributions
  for insert with check (contributor_id = auth.uid() and public.is_active_staff());

-- Your words stay yours: the requester can read but never edit or delete them.
drop policy if exists pd_prep_contrib_update on public.pd_prep_contributions;
create policy pd_prep_contrib_update on public.pd_prep_contributions
  for update using (contributor_id = auth.uid()) with check (contributor_id = auth.uid());

drop policy if exists pd_prep_contrib_delete on public.pd_prep_contributions;
create policy pd_prep_contrib_delete on public.pd_prep_contributions
  for delete using (contributor_id = auth.uid());

comment on table public.pd_prep_feedback_requests is
  'Manager asks a colleague to contribute to their PRIVATE 1-2-1 prep. Visible '
  'to requester and responder only — never to the subject of the feedback.';
comment on table public.pd_prep_contributions is
  'A colleague''s contribution to someone else''s private 1-2-1 prep. Visible to '
  'the requester and the author only — never to the subject.';

-- ── 4. In-app notifications ─────────────────────────────────────────────────
-- notifications has no client INSERT policy (written server-side), so these
-- fire as security definer triggers. Neither ever notifies the subject.

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
    coalesce(new.message, 'Shared privately with them only — it is not visible to '
      || coalesce(v_subject, 'the person it is about') || '.'),
    '/team/pd/prep',
    'prep_fr:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists pd_prep_notify_request on public.pd_prep_feedback_requests;
create trigger pd_prep_notify_request
  after insert on public.pd_prep_feedback_requests
  for each row execute function public.pd_prep_notify_request();

create or replace function public.pd_prep_notify_contribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contributor text;
  v_subject     text;
begin
  select name into v_contributor from staff_profiles where id = new.contributor_id;
  select name into v_subject     from staff_profiles where id = new.subject_id;
  insert into notifications (recipient_id, kind, title, body, link_path, source_key)
  values (
    new.requester_id,
    'prep_feedback_given',
    coalesce(v_contributor, 'A colleague') || ' added input on ' || coalesce(v_subject, 'a colleague'),
    left(new.body, 180),
    '/team/pd/prep',
    'prep_contrib:' || new.id::text
  );
  return new;
end;
$$;

drop trigger if exists pd_prep_notify_contribution on public.pd_prep_contributions;
create trigger pd_prep_notify_contribution
  after insert on public.pd_prep_contributions
  for each row execute function public.pd_prep_notify_contribution();
