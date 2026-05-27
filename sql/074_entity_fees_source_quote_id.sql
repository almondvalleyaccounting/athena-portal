-- 074_entity_fees_source_quote_id.sql
-- Adds provenance link from a live fee back to the quote it was committed from.
-- Written by CommitToLiveModal at commit-to-live time (source = 'committed_quote').
-- ON DELETE SET NULL: deleting a quote must not cascade-delete the live fee.

ALTER TABLE public.entity_fees
  ADD COLUMN IF NOT EXISTS source_quote_id uuid
    REFERENCES public.quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_entity_fees_source_quote_id
  ON public.entity_fees (source_quote_id);
