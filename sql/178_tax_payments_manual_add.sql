-- 178 — Client Tax Reminders: manually added payment rows.
--
-- Some clients join us after their Self Assessment was filed elsewhere, so
-- the TaxCalc payments-on-account export is not the source of their payment
-- figures. Those rows are keyed in by hand instead, and we need to be able
-- to tell them apart from imported ones: a manual row is editable and
-- deletable, an imported row is not (it would drift from TaxCalc).
--
-- source   'taxcalc' (imported, the default so every existing row is
--          correctly labelled) or 'manual' (keyed in by staff).
-- added_by the staff member who keyed it in — batches record uploaded_by,
--          individual manual rows had nowhere to record authorship.

alter table public.tax_payments_due
  add column if not exists source text not null default 'taxcalc',
  add column if not exists added_by uuid references public.staff_profiles(id);

do $$
begin
  alter table public.tax_payments_due
    add constraint tax_payments_due_source_chk check (source in ('taxcalc', 'manual'));
exception
  when duplicate_object then null;
end $$;

-- Supports the "is this client already in this batch?" duplicate check the
-- manual-add form runs before inserting. Deliberately NOT unique: TaxCalc
-- exports can legitimately carry more than one row for a taxpayer.
create index if not exists tax_payments_due_batch_entity_idx
  on public.tax_payments_due (batch_id, entity_id);

comment on column public.tax_payments_due.source is
  'taxcalc = imported from a TaxCalc export; manual = keyed in by staff (e.g. a client who joined after their SA was filed elsewhere).';
