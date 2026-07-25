-- 169: Client Forecast — make output persistence safe under concurrent recomputes.
--
-- persistOutputs() deleted every row for the scenario and then inserted the
-- new set in chunks, with no transaction. Two overlapping recomputes
-- therefore interleave as delete / delete / insert / insert and leave TWO
-- complete sets of outputs. That happened to the Puddleduck "3-5 heavy"
-- version on 2026-07-25: every nominal type present exactly twice, which
-- doubled staff cost, headcount and revenue and made the version look wildly
-- different from its siblings.
--
-- Fix pattern (no transaction needed): stamp each run with a uuid, INSERT the
-- new set first, then delete everything for that scenario carrying a
-- different stamp. Two concurrent runs then resolve to whichever finishes
-- its delete last — one complete set either way, never two, and never a
-- window where the scenario has no outputs at all.

alter table fc_output add column if not exists run_id uuid;

-- Helps the post-insert cleanup and the per-scenario reads.
create index if not exists fc_output_scenario_run_idx on fc_output (scenario_id, run_id);
