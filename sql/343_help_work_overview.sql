-- Help copy for Work → Overview (/planner). Its own id, wp-overview, because
-- wp-task covers every Planner tab. HelpButton renders "## " as a heading and
-- "- " as a bullet.

insert into public.help_content (module_id, section_key, title, body, sort_order)
values ('wp-overview', 'overview', 'Work · Overview', $body$## What this page is
The team's work for the next six months, and anything that needs you now.

## The grid
- Months across, type of work down.
- Big number = filings due. Small number = hours.
- A job counts once (the submission). Hours include the prep.
- Darker blue = busier month.
- 🏖 = days off booked that month.
- Hover a number to see who has it. Click it for the jobs.

## Buttons at the top
- Task view / Team view: rows by type of work, or by person.
- By deadline / By planned date: when it's due, or when it's booked in.
- Team filter: show one person only.

## The five tiles
- Overdue: past its date. Red means deal with it today.
- This week, Next week, Week after next: a week ends on Friday.
- Other tasks: BM non-standard tasks and quick tasks.

## In a job list
- Click a row to open the task.
- Actions: mark complete, log time, move to today, reassign, email.
- Select the reference number to copy it.

## Boxes under the grid
These only show when something needs you.
- The client has been in touch: they replied or uploaded. Chases stop until you pick Records in or Still waiting.
- Holiday handover: tasks during your time off have no plan yet. Sort it before the due date.
- Jobs needing attention: urgent, at risk, waiting on the client or slipped. Click to open the workflow.
- Update in BrightManager: done here, not yet in BM. Complete it in BM, then press Done in BM.

## Good habits
- Check Overdue first thing.
- Mark jobs complete as you finish. The time goes to your timesheet.
- Look at the grid before booking holiday.

## Where the numbers come from
BrightManager jobs (as last imported), workflows, quick tasks and holidays in Athena.$body$, 0)
on conflict (module_id, section_key) do update
  set title = excluded.title, body = excluded.body;
