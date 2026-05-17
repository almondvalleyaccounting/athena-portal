-- Add `nlac` (No Longer A Client) to the entity_status enum.
-- Distinct from `archived` (fully retired / historic only). NLAC means
-- the client has left but may return, and should be excluded from
-- forward-looking views (e.g. Fee Engine billing review).
ALTER TYPE entity_status ADD VALUE IF NOT EXISTS 'nlac' AFTER 'active';
