-- 356: the Group Quote Builder keeps its inputs.
--
-- The builder saved only the resulting £ lines, so reopening it showed every
-- driver (turnover, bookkeeping hours, directors, VAT returns…) blank and every
-- figure as a bare override. It now stores what was typed — drivers and
-- overrides — on the quote it wrote, and reads them back on open.
--
-- No grant change: quotes keeps its existing table grants and RLS.

alter table public.quotes
  add column if not exists builder_inputs jsonb;

comment on column public.quotes.builder_inputs is
  'Group Quote Builder state for this quote: {drivers, overrides, discount}. Written by the builder only.';
