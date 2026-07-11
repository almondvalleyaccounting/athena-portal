-- CPD sharing + 360 feedback requests.
--
-- pd_access_grants: an individual grants a specific mentor/manager view+write
--   access to their CPD (skills, objectives, CPD log, 1-2-1s).
-- pd_feedback_requests: an individual asks any colleague to give feedback on a
--   1-2-1 WITHOUT granting them any broader view access — the responder only
--   sees that request and posts a comment on the named 1-2-1.

create table if not exists pd_access_grants (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references staff_profiles(id) on delete cascade,
  grantee_id uuid not null references staff_profiles(id) on delete cascade,
  role       text not null default 'mentor' check (role in ('mentor','manager')),
  created_at timestamptz not null default now(),
  unique (owner_id, grantee_id)
);
create index if not exists pd_access_grants_grantee_idx on pd_access_grants (grantee_id);
create index if not exists pd_access_grants_owner_idx on pd_access_grants (owner_id);

create table if not exists pd_feedback_requests (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references staff_profiles(id) on delete cascade,
  responder_id  uuid not null references staff_profiles(id) on delete cascade,
  one_to_one_id uuid references pd_one_to_ones(id) on delete cascade,
  message       text,
  status        text not null default 'open' check (status in ('open','answered','declined')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);
create index if not exists pd_feedback_req_responder_idx on pd_feedback_requests (responder_id, status);
create index if not exists pd_feedback_req_subject_idx on pd_feedback_requests (subject_id);

alter table pd_access_grants      enable row level security;
alter table pd_feedback_requests  enable row level security;

drop policy if exists pd_access_grants_all on pd_access_grants;
create policy pd_access_grants_all on pd_access_grants
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

drop policy if exists pd_feedback_requests_all on pd_feedback_requests;
create policy pd_feedback_requests_all on pd_feedback_requests
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

comment on table pd_access_grants is 'A staff member grants a mentor/manager view+write access to their CPD.';
comment on table pd_feedback_requests is '360 feedback invites — respond to a 1-2-1 without any broader view access.';
