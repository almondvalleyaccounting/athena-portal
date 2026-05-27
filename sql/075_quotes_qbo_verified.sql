-- 075_quotes_qbo_verified.sql
-- "Verified in QB" lock for committed quotes. A committed quote stays
-- revertible to 'accepted' (e.g. when the QBO push didn't actually land)
-- until it's verified — after which it's locked and can't be moved back.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS qbo_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS qbo_verified_by uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL;
