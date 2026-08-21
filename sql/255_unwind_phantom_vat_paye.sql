-- 255: Unwind the phantom VAT and PAYE the close-out laundered into history.
--
-- sql/254 taught the cross-check that a completed onboarding's service flags
-- are history — which fixed the verdicts but left the record itself wrong.
-- The 2026-07-12 tracker import seeded 'vat' and 'paye' conditions (the old
-- combined "Bookkeeping & VAT" meaning sql/102 left to be unticked by hand)
-- onto clients that never had those services, with their checklist steps as
-- 'pending'. Then sql/242's close-out ticked every pending step on completed
-- onboardings — so Hashtag Rose's detail page and Board cells read "Enter VAT
-- number on BM and validate ✓" for a VAT number that has never existed. That
-- tick manufactured history, and hiding it at the view layer is not a fix.
--
-- A condition is phantom when, on a COMPLETED onboarding, nothing anywhere
-- supports it: no fee, no BM scheduled work, no reference, no HMRC presence
-- (exactly v_onboarding_crosscheck.we_do, which after sql/254 no longer
-- counts these flags themselves). Scope is deliberately vat + paye only —
-- the two the combined-product seeding is known to have fabricated. Company
-- 'sa' flags are left alone because they legitimately stand behind the
-- directors' SA step groups.
--
-- For each phantom condition:
--   * steps the close-out ticked (auto_completed_at set, status_before_auto
--     'pending') become 'na' — the truthful state for a service that does not
--     apply. The auto-complete marks are cleared, so a later Reopen leaves
--     them at 'na' instead of restoring the wrong 'pending'.
--   * steps a person ticked are untouched: "(if req)" steps are routinely
--     completed to mean "checked, not required", and that is real history.
--   * the condition comes off onboardings.service_conditions, finishing
--     sql/102's per-client untick with evidence instead of by hand.
--
-- Dry-run on 2026-08-21: 49 onboardings, 80 conditions, 237 steps to na,
-- 15 human-ticked steps untouched.
with unsupported as (
  select o.id as onboarding_id, o.entity_id, c.cond
    from onboardings o
    cross join lateral unnest(o.service_conditions) c(cond)
   where o.archived_at is null and o.status = 'complete'
     and c.cond in ('vat','paye')
     and not exists (select 1 from v_onboarding_crosscheck x
                      where x.entity_id = o.entity_id and x.tax = c.cond and x.we_do)
),
flip as (
  update onboarding_steps s
     set status = 'na',
         completed_at = null,
         completed_by = null,
         auto_completed_at = null,
         status_before_auto = null,
         updated_at = now(),
         note = coalesce(s.note || ' — ', '')
                || 'Set to N/A 2026-08-21: the '
                || case u.cond when 'vat' then 'VAT' else 'PAYE' end
                || ' condition was seeded by the tracker import and nothing supports it; the close-out had ticked this step as complete.'
    from unsupported u
   where s.onboarding_id = u.onboarding_id
     and s.service_condition = u.cond
     and s.auto_completed_at is not null
     and s.status_before_auto = 'pending'
  returning s.onboarding_id, u.cond
),
untick as (
  update onboardings o
     set service_conditions = (
           select coalesce(array_agg(x), '{}')
             from unnest(o.service_conditions) x
            where x not in (select cond from unsupported u2 where u2.onboarding_id = o.id)
         )
   where o.id in (select onboarding_id from unsupported)
  returning o.id
)
insert into onboarding_activity (onboarding_id, kind, body)
select u.onboarding_id, 'system',
       'Removed phantom service condition(s) '
       || string_agg(upper(u.cond), ', ' order by u.cond)
       || ' — seeded by the 2026-07-12 tracker import with no fee, no BM work, no reference and no HMRC presence behind them. '
       || coalesce(f.n::text, '0') || ' close-out-ticked step(s) set back to N/A.'
  from unsupported u
  left join (select onboarding_id, count(*) n from flip group by 1) f
    on f.onboarding_id = u.onboarding_id
 group by u.onboarding_id, f.n;
