-- 059_purge_corrupt_ch_data.sql
-- One-shot cleanup after fixing two bugs in the CH ingest edge function:
--   1. Officer-id URL parsing returned the literal "appointments" instead of
--      the officer id, so all directors collided onto one person record.
--   2. Name-based fallback match treated NULL DOB as a free pass, so common
--      names (e.g. "Robert Gallacher") merged unrelated officers.
--
-- Wipe all CH-sourced links and people; sole-trader / partnership auto-seeded
-- people are untouched. Re-run the CH ingest after applying.

DELETE FROM entity_people WHERE source IN ('ch_officers', 'ch_psc');
DELETE FROM people        WHERE source IN ('ch_officer',  'ch_psc');
