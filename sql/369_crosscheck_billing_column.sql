-- ============================================================
-- 369 — Cross-check: Billing is its own mark
--
-- sql/368 folded "Billing missing" into the CT / SA / VAT / PAYE marks, so a
-- mark that was both "agent missing" and "billing missing" could only be
-- overridden as a whole, and billing had no mark of its own to click. Billing
-- now has its own column, so it is overridden on its own (e.g. billed through
-- another company in the group). The override table accepts the new key.
-- ============================================================

alter table public.onboarding_crosscheck_overrides
  drop constraint if exists onboarding_crosscheck_overrides_check_key_check;

alter table public.onboarding_crosscheck_overrides
  add constraint onboarding_crosscheck_overrides_check_key_check
  check (check_key in ('loe','ct','sa','vat','paye','bp','tc','qbo','fee','billing'));
