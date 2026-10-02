-- 347: Prep notes get a headline and a hidden detail.
--
-- The ask (Bobby, 2026-10-02): a long note swamps the column. Sophie's
-- "Payroll errors" note was 1,500 characters of examples, and it pushed every
-- other point off the screen. The headline is what goes on the agenda; the
-- detail is the evidence, read when the note is opened.
--
-- Same row, so the author-only RLS on pd_prep_notes (sql/183) covers it with no
-- new policy. No grant change: the table carries no column-level grants.

alter table public.pd_prep_notes
  add column if not exists detail text;

comment on column public.pd_prep_notes.detail is
  'Longer notes behind the headline (body). Collapsed until clicked. Author-only, like the rest of the row.';
