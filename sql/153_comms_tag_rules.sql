-- 153: Communications — learned sender→label rules for auto-suggested tags.
--
-- Purpose: the email inbox suggests a tag for each thread so staff can
-- eyeball it and one-click "tag + archive" (mass inbox clearing). Rules are
-- learned two ways:
--   * 'history' — comms-gmail's learn_labels action scans threads already
--     sitting under each user label and records their senders (service role,
--     merged via merge_comms_tag_rules so re-learning never double-counts).
--   * 'manual'  — every tag applied in Athena reinforces the rule for that
--     sender (record_comms_tag, called from the UI, +1 each time).
--
-- Suggestions are advisory only — nothing is auto-applied without a click.

create table if not exists public.comms_tag_rules (
  id uuid primary key default gen_random_uuid(),
  mailbox_email text not null,            -- lower(gmail_connections.account_email)
  sender_email text not null,             -- lower, full address
  sender_domain text not null default '', -- lower, part after @ (freemail domains ignored client-side)
  label_id text not null,                 -- Gmail label id (stable per mailbox)
  label_name text not null,               -- display + fallback if the id disappears
  times_used integer not null default 1,
  source text not null default 'manual' check (source in ('manual', 'history')),
  last_used_at timestamptz not null default now(),
  unique (mailbox_email, sender_email, label_id)
);
create index if not exists comms_tag_rules_mailbox_idx on public.comms_tag_rules (mailbox_email);

alter table public.comms_tag_rules enable row level security;
drop policy if exists "Staff read comms tag rules" on public.comms_tag_rules;
create policy "Staff read comms tag rules" on public.comms_tag_rules
  for select using (is_active_staff());
-- Writes go through the two functions below (or service role).

-- One manual tagging decision from the UI: upsert + increment.
create or replace function public.record_comms_tag(
  p_mailbox text, p_sender text, p_label_id text, p_label_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_active_staff() then
    raise exception 'Not authorised';
  end if;
  if coalesce(trim(p_sender), '') = '' or coalesce(trim(p_label_id), '') = '' then
    return;
  end if;
  insert into comms_tag_rules (mailbox_email, sender_email, sender_domain, label_id, label_name, source)
  values (
    lower(trim(p_mailbox)),
    lower(trim(p_sender)),
    split_part(lower(trim(p_sender)), '@', 2),
    p_label_id,
    p_label_name,
    'manual'
  )
  on conflict (mailbox_email, sender_email, label_id) do update
    set times_used = comms_tag_rules.times_used + 1,
        label_name = excluded.label_name,
        source = 'manual',
        last_used_at = now();
end;
$$;

revoke execute on function public.record_comms_tag(text, text, text, text) from public, anon;
grant execute on function public.record_comms_tag(text, text, text, text) to authenticated, service_role;

-- Bulk merge from a history scan (comms-gmail learn_labels, service role).
-- p_rules: [{ sender, label_id, label_name, count }]. greatest() so a
-- re-scan refreshes counts without double-counting, and never shrinks a
-- rule that manual use has pushed higher.
create or replace function public.merge_comms_tag_rules(p_mailbox text, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  merged integer;
begin
  if auth.role() <> 'service_role' and not is_active_staff() then
    raise exception 'Not authorised';
  end if;
  insert into comms_tag_rules (mailbox_email, sender_email, sender_domain, label_id, label_name, times_used, source)
  select
    lower(trim(p_mailbox)),
    lower(r.sender),
    split_part(lower(r.sender), '@', 2),
    r.label_id,
    r.label_name,
    greatest(r.count, 1),
    'history'
  from jsonb_to_recordset(p_rules)
    as r(sender text, label_id text, label_name text, count integer)
  where coalesce(trim(r.sender), '') <> '' and coalesce(trim(r.label_id), '') <> ''
  on conflict (mailbox_email, sender_email, label_id) do update
    set times_used = greatest(comms_tag_rules.times_used, excluded.times_used),
        label_name = excluded.label_name;
  get diagnostics merged = row_count;
  return merged;
end;
$$;

revoke execute on function public.merge_comms_tag_rules(text, jsonb) from public, anon;
grant execute on function public.merge_comms_tag_rules(text, jsonb) to authenticated, service_role;
