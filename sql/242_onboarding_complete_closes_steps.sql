-- 242: Marking an onboarding Complete closes out the checklist — reversibly.
--
-- Pressing Complete on a client who is genuinely finished used to leave the
-- checklist half-ticked (CS Abode Architects sat at 2/9 complete), so the
-- progress bar and the "Complete" filter told two different stories. Complete
-- now ticks every step that is still open, but records what it did so Reopen
-- can put the list back exactly as it was:
--
--   auto_completed_at  — set when the ob-level Complete ticked this step
--   status_before_auto — the status it held at that moment ('pending',
--                        'waiting_client', 'waiting_external', 'blocked',
--                        'received')
--
-- Reopen restores status_before_auto and clears both columns. A step a human
-- ticked carries neither, so Reopen leaves it complete.

alter table onboarding_steps
  add column if not exists auto_completed_at  timestamptz,
  add column if not exists status_before_auto text;

comment on column onboarding_steps.auto_completed_at is
  'Set when the onboarding-level Complete ticked this step rather than a person. Reopen reverts these to status_before_auto and clears both columns.';
comment on column onboarding_steps.status_before_auto is
  'Status held immediately before auto_completed_at was stamped, so Reopen is exact.';

create index if not exists idx_onboarding_steps_auto_complete
  on onboarding_steps(onboarding_id) where auto_completed_at is not null;

-- ── Legacy: imported-as-complete onboardings never got completed_at ──
-- 73 rows came in from Sophie's tracker on 2026-07-12 with status 'complete'
-- and completed_at null, so they sat in the Complete filter but never reached
-- v_onboarding_updates. Backfill from created_at (their historic import date)
-- rather than now(), so they cannot resurface in the weekly "what moved" email.
update onboardings
   set completed_at = created_at
 where status = 'complete'
   and completed_at is null;

-- ── The updates feed must not report auto-completed steps as milestones ──
-- Without this, closing out a client would email the team "🔑 Companies House
-- auth code received" / "🧾 VAT number received" for codes that never arrived.
-- The 'completed' branch also now requires status = 'complete', so a stale
-- completed_at on a reopened onboarding cannot announce a completion.
create or replace view v_onboarding_updates with (security_invoker = true) as
  select o.id                as onboarding_id,
         e.id                as entity_id,
         e.name              as entity_name,
         'milestone'::text   as kind,
         s.name              as title,
         s.completed_at      as happened_at
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
    join entities    e on e.id = o.entity_id
   where s.milestone
     and s.status = 'complete'
     and s.completed_at is not null
     and s.auto_completed_at is null
     and o.archived_at is null
     and e.entity_status <> all (array['nlac'::entity_status, 'archived'::entity_status])
  union all
  select r.onboarding_id,
         e.id   as entity_id,
         e.name as entity_name,
         'service_request'::text as kind,
         'Client requested a new service: ' || coalesce(r.service_title, r.service_id) as title,
         r.created_at as happened_at
    from portal_service_requests r
    join entities e on e.id = r.entity_id
   where e.entity_status <> all (array['nlac'::entity_status, 'archived'::entity_status])
  union all
  select o.id   as onboarding_id,
         e.id   as entity_id,
         e.name as entity_name,
         'started'::text as kind,
         'Onboarding started'::text as title,
         o.created_at as happened_at
    from onboardings o
    join entities e on e.id = o.entity_id
   where o.status <> 'cancelled'
     and o.archived_at is null
     and e.entity_status <> all (array['nlac'::entity_status, 'archived'::entity_status])
  union all
  select o.id   as onboarding_id,
         e.id   as entity_id,
         e.name as entity_name,
         'completed'::text as kind,
         'Onboarding complete 🎉'::text as title,
         o.completed_at as happened_at
    from onboardings o
    join entities e on e.id = o.entity_id
   where o.completed_at is not null
     and o.status = 'complete'
     and o.archived_at is null
     and e.entity_status <> all (array['nlac'::entity_status, 'archived'::entity_status]);

-- ── One-off: close out the checklists of onboardings already marked complete ──
-- 77 onboardings (CS Abode Architects among them, showing 2/9) were marked
-- complete before Complete closed anything out, so their progress bars still
-- read part-done. Close them out through the same mechanism, which means Reopen
-- reinstates them exactly like any other. They all share one auto_completed_at,
-- so the whole sweep is revertible in one statement if it isn't wanted:
--
--   update onboarding_steps
--      set status = status_before_auto, completed_at = null,
--          auto_completed_at = null, status_before_auto = null
--    where auto_completed_at = (select min(auto_completed_at) from onboarding_steps);
update onboarding_steps s
   set status             = 'complete',
       completed_at       = now(),
       auto_completed_at  = now(),
       status_before_auto = s.status,
       updated_at         = now()
  from onboardings o
 where o.id = s.onboarding_id
   and o.status = 'complete'
   and s.status in ('pending','waiting_client','waiting_external','blocked','received');
