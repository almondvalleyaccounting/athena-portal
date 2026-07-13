-- 101: Clear systematically over-inclusive services from the imported batch.
--
-- The 12/07 tracker import (created_by null) copied every template group onto
-- each company client and left un-actioned groups as 'pending', so conditions
-- were inferred that the client doesn't actually take. Two are systematic:
--   confirmation_statement — 0 of 87 clients ever actioned it (not really an
--                            onboarding step; it's a recurring annual task)
--   cis                    — untouched on 83 of 86 (maps to no fee-engine
--                            service; only 3 construction clients use it)
--
-- Clear these ONLY where the condition is "untouched" for that client (no
-- complete step, none waiting/blocked/received — i.e. every step still
-- pending). VAT/PAYE/etc are genuinely mixed and left for per-client review
-- in the Services panel. Completed/in-progress steps are never changed, and
-- re-ticking the service in the panel restores everything.

-- 1) Remove the untouched cis/confirmation_statement keys from each imported
--    onboarding's service_conditions (computed from the ORIGINAL step data).
update onboardings o
   set service_conditions = (
     select coalesce(array_agg(c order by c), '{}')
       from unnest(o.service_conditions) c
      where c not in (
        select cs.cond from (
          select s2.onboarding_id, s2.service_condition as cond,
                 count(*) filter (where s2.status = 'complete') as done,
                 count(*) filter (where s2.status in ('waiting_client','waiting_external','blocked','received')) as active
            from onboarding_steps s2
           where s2.service_condition in ('cis','confirmation_statement') and s2.status <> 'na'
           group by s2.onboarding_id, s2.service_condition
        ) cs
        where cs.done = 0 and cs.active = 0 and cs.onboarding_id = o.id
      )
   )
 where o.created_by is null;

-- 2) N/A the now-orphaned pending steps for those same untouched conditions.
update onboarding_steps s
   set status = 'na', updated_at = now()
  from (
    select cs.onboarding_id, cs.cond
      from (
        select s2.onboarding_id, s2.service_condition as cond,
               count(*) filter (where s2.status = 'complete') as done,
               count(*) filter (where s2.status in ('waiting_client','waiting_external','blocked','received')) as active
          from onboarding_steps s2
          join onboardings o on o.id = s2.onboarding_id and o.created_by is null
         where s2.service_condition in ('cis','confirmation_statement') and s2.status <> 'na'
         group by s2.onboarding_id, s2.service_condition
      ) cs
     where cs.done = 0 and cs.active = 0
  ) u
 where s.onboarding_id = u.onboarding_id
   and s.service_condition = u.cond
   and s.status = 'pending';
