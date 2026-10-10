-- 372_grade_bm_restore.sql
--
-- Follow-up to 371. With only grade_override, clearing an Athena grade left the
-- old override sitting in entities.grade until the next BrightManager import.
-- grade_bm keeps BM's own answer so clearing the override puts it straight back.
--
-- Any write that changes grade (the importer, in practice) is BM speaking:
-- record it in grade_bm before the override is applied on top. A write that
-- only touches grade_override leaves grade unchanged, so it is not mistaken
-- for BM.

alter table public.entities add column if not exists grade_bm text;
update public.entities set grade_bm = grade where grade_override is null and grade_bm is distinct from grade;

create or replace function public.entities_apply_grade_override()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.grade_bm := new.grade;
  elsif new.grade is distinct from old.grade then
    new.grade_bm := new.grade;
  end if;

  if new.grade_override is not null then
    new.grade := new.grade_override;
  elsif tg_op = 'UPDATE' and old.grade_override is not null then
    new.grade := new.grade_bm;
  end if;
  return new;
end;
$$;
revoke execute on function public.entities_apply_grade_override() from public, anon, authenticated;
