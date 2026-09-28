-- ============================================================
-- 342: A merge decision can carry a reason.
--
-- bm_person_merge_review blocks a pair when the two names disagree — the
-- guard that keeps family members sharing a BM reference apart. A change of
-- name looks identical (Laura Wright → Laura Clark, WRIGL01, same code, same
-- email, same DOB month). The Duplicate people screen now lets staff merge a
-- blocked pair, but only with a stated reason, and that reason belongs on the
-- review row next to who decided and when.
--
-- set_bm_person_merge_verdict gains an optional p_note. The two-argument
-- version is dropped rather than overloaded so there is one signature to
-- guard. Grants re-stated explicitly: a new function is EXECUTE-able by anon
-- through the schema default privilege, and `revoke from public` misses it.
-- ============================================================

alter table public.bm_person_merge_review add column if not exists decision_note text;

drop function if exists public.set_bm_person_merge_verdict(uuid[], text);

create or replace function public.set_bm_person_merge_verdict(p_ids uuid[], p_verdict text, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required' using errcode = '42501';
  end if;

  -- 'applied' is only ever set by apply_bm_person_merges, which does the work.
  if p_verdict not in ('proposed', 'rejected', 'blocked') then
    raise exception 'verdict must be proposed, rejected or blocked (got %)', p_verdict;
  end if;

  update bm_person_merge_review
     set verdict = p_verdict,
         decision_note = coalesce(nullif(btrim(p_note), ''), decision_note),
         decided_by = auth.uid(), decided_at = now()
   where id = any(coalesce(p_ids, '{}'::uuid[]))
     and verdict <> 'applied';

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.set_bm_person_merge_verdict(uuid[], text, text) from public, anon;
grant execute on function public.set_bm_person_merge_verdict(uuid[], text, text) to authenticated, service_role;
