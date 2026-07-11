-- Role profiles carry a narrative description (overview, duties, skills,
-- behaviours) alongside their skill-category targets. Shown as a "Role profile"
-- sub-tab next to "Skills" in the CPD Tracker Roles editor.
alter table pd_role_profiles add column if not exists profile_text text;
comment on column pd_role_profiles.profile_text is 'Narrative role description (markdown/plain text) shown in the Role profile sub-tab.';
