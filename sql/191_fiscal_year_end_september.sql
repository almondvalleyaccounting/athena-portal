-- 191: firm year-end is SEPTEMBER (Bobby, 2026-08-07) — sql/190 guessed
-- March. Correct existing scenarios and the default for new ones. The
-- setting stays editable per-scenario in the Cash & Owner assumptions
-- panel; this just makes the right value the resting state.

update plan_scenarios set fiscal_year_end_month = 9 where fiscal_year_end_month = 3;

alter table plan_scenarios alter column fiscal_year_end_month set default 9;

comment on column plan_scenarios.fiscal_year_end_month is
  'Firm''s own accounting year-end month (1-12). Drives the CT payment date (YE + 9 months + 1 day). September per Bobby 2026-08-07; editable on the Cash & Owner tab.';
