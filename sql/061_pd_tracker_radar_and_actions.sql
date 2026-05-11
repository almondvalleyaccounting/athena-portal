-- 061_pd_tracker_radar_and_actions.sql
-- (a) replace the generic seeded skill matrix with the real one we use
-- (b) add a per-staff "show on spider diagram" flag
-- (c) link 1-2-1 actions to a quick_tasks row so they show up in the planner

TRUNCATE pd_skills RESTART IDENTITY CASCADE;

ALTER TABLE pd_skill_levels
  ADD COLUMN IF NOT EXISTS show_on_radar boolean NOT NULL DEFAULT false;

ALTER TABLE pd_one_to_one_actions
  ADD COLUMN IF NOT EXISTS quick_task_id uuid REFERENCES quick_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pd_actions_quick_task_idx ON pd_one_to_one_actions (quick_task_id);

-- Skill seed lives in 062_pd_tracker_seed_real_skills.sql for readability.
