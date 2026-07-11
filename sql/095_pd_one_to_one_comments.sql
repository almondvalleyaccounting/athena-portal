-- 360° comments on a 1-2-1. A multi-author thread so the individual, their
-- manager, and anyone given access can each add attributed comments — kept
-- separate from the meeting's own reflection fields.
create table if not exists pd_one_to_one_comments (
  id            uuid primary key default gen_random_uuid(),
  one_to_one_id uuid not null references pd_one_to_ones(id) on delete cascade,
  author_id     uuid references staff_profiles(id) on delete set null,
  body          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists pd_1v1_comments_idx on pd_one_to_one_comments (one_to_one_id, created_at);

alter table pd_one_to_one_comments enable row level security;
drop policy if exists pd_one_to_one_comments_all on pd_one_to_one_comments;
create policy pd_one_to_one_comments_all on pd_one_to_one_comments
  for all to authenticated using (is_active_staff()) with check (is_active_staff());

comment on table pd_one_to_one_comments is 'Attributed 360 comments on a 1-2-1 (from the individual, manager, or anyone given access).';
