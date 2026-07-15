-- 103_ideas_status_comments.sql
-- Ideas triage: support admin comments (rejection reason / info request) and a
-- submitter response to an info request. Status vocabulary is enforced only in
-- the app (text column), so no constraint change is required here.

alter table public.ideas
  add column if not exists admin_comment       text,
  add column if not exists admin_comment_by    text,
  add column if not exists admin_comment_at    timestamptz,
  add column if not exists submitter_response  text,
  add column if not exists submitter_response_at timestamptz;

comment on column public.ideas.admin_comment is
  'Triage note attached to a status change — rejection reason or the question asked of the submitter.';
comment on column public.ideas.submitter_response is
  'Submitter''s reply to an information request (status = more_info).';
