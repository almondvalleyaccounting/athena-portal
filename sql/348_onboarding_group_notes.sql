-- 348: Onboarding notes at task-group level (Onboarding, SA, CT, VAT, PAYE …).
--
-- The ask (Bobby, 2026-10-05): a note about the VAT leg belongs with the VAT
-- tasks, not lost in the one onboarding-wide thread.
--
-- A group note is an ordinary onboarding_activity note that names its group.
-- Groups have no table of their own — onboarding_steps.group_name is the key the
-- checklist already groups on — so the note carries the same text. Null means
-- the onboarding-wide thread, which is every note written before this.
--
-- Same row, so the existing is_active_staff() policies on onboarding_activity
-- cover it with no new policy. No grant change: the table carries no
-- column-level grants.

alter table public.onboarding_activity
  add column if not exists group_name text;

comment on column public.onboarding_activity.group_name is
  'Task group the note belongs to (matches onboarding_steps.group_name). Null = onboarding-wide.';

create index if not exists onboarding_activity_group_idx
  on public.onboarding_activity (onboarding_id, group_name)
  where group_name is not null;
