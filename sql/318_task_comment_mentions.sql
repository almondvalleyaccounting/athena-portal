-- ============================================================
-- 318 — @mentions on task comments
--
-- Bobby, 2026-09-26: typing @ in the comment box offers the team; a
-- mentioned person gets the comment by email even if they were not on the
-- thread, and from then on they are on it.
-- ============================================================

alter table public.task_comments add column if not exists mentions uuid[] not null default '{}';
comment on column public.task_comments.mentions is 'Staff mentioned with @ in the comment (sql/318); they are notified and join the thread.';
