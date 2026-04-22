// BrightManager Tasks export → normalised per-row payload for the
// import_bm_tasks RPC. Column names verified against the 15/04/2026
// export (open tasks list).
//
// CSV shape (header order as exported):
//   Client ID, Client Name, Client Reference, Client Type,
//   Task ID, Task Name, Task Description, Task Progress,
//   Latest Action Date, Progress Notes, Target Date, Deadline,
//   Assignee Name, Completed?, Completed By, Completion Date,
//   Logged?, Estimate (hours)
//
// Operating model: the CSV contains OPEN tasks only. Completion is
// detected by disappearance on a later import. Rows that arrive
// with Completed? = Y are filtered here — their presence is an
// export anomaly and including them would create false-positive
// completed_no_time flags on the next upload (historical timesheet
// entries don't carry source_task_id pointers back to the schedule
// row). If we ever want to seed historical attribution, a separate
// one-off migration is the right place.

import { parseCsv } from '../parseCsv';

function normText(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}

function normYN(v) {
  const t = normText(v);
  if (t === null) return null;
  const upper = t.toUpperCase();
  if (upper === 'Y' || upper === 'YES' || upper === 'TRUE') return true;
  if (upper === 'N' || upper === 'NO' || upper === 'FALSE') return false;
  return null;
}

function normNumber(v) {
  const t = normText(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Pass raw date strings through — server parse_bm_date handles both
// DD/MM/YYYY and YYYY-MM-DD. "N/A" and other non-date sentinels
// become null.
function normDate(v) {
  const t = normText(v);
  if (t === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return t;
  return null;
}

export function parseBmTasksCsv(text) {
  const raw = parseCsv(text);
  if (raw.length < 2) {
    return { rows: [], warnings: [], skipped: [], seenTaskIds: [], headerOk: false };
  }
  const header = raw[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  const idxOf = (name) => header.indexOf(name);

  const required = ['Task ID', 'Task Name', 'Client Reference'];
  const missing = required.filter((c) => idxOf(c) < 0);
  if (missing.length) {
    return {
      rows: [], warnings: [], skipped: [], seenTaskIds: [],
      headerOk: false,
      headerError: `Missing required columns: ${missing.join(', ')}`,
    };
  }

  const get = (row, name) => {
    const i = idxOf(name);
    return i < 0 ? null : normText(row[i]);
  };

  const rows = [];
  const warnings = [];
  const skipped = [];
  const seenTaskIds = [];

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (row.length !== header.length) continue; // malformed
    if (!row.some((c) => c && String(c).trim())) continue; // blank

    const taskId = get(row, 'Task ID');
    const taskName = get(row, 'Task Name');
    const clientRef = get(row, 'Client Reference');
    const clientName = get(row, 'Client Name');
    const completed = normYN(get(row, 'Completed?'));
    const completionDate = normDate(get(row, 'Completion Date'));

    if (!taskId) {
      skipped.push({ row: i + 1, bm_task_id: null, name: taskName, field: 'Task ID', reason: 'missing Task ID' });
      continue;
    }

    // Record every task_id we saw, even skipped ones. Used for the
    // disappearance sweep — a row that was skipped this import but
    // exists in bm_task_schedule should NOT be treated as completed.
    seenTaskIds.push(taskId);

    if (!taskName) {
      skipped.push({ row: i + 1, bm_task_id: taskId, name: null, field: 'Task Name', reason: 'missing Task Name' });
      continue;
    }
    if (!clientRef) {
      skipped.push({ row: i + 1, bm_task_id: taskId, name: taskName, field: 'Client Reference', reason: 'missing Client Reference' });
      continue;
    }

    // Filter Completed=Y rows at parse (see file header comment).
    if (completed === true) {
      warnings.push({
        row: i + 1, bm_task_id: taskId, name: taskName,
        field: 'Completed?',
        message: `Completed=Y filtered out (completion_date=${completionDate || '—'}); will not be scheduled`,
      });
      continue;
    }

    rows.push({
      _source_row: i + 1,
      bm_task_id:          taskId,
      bm_task_name:        taskName,
      client_reference:    clientRef,
      client_name:         clientName,
      task_progress:       get(row, 'Task Progress'),
      latest_action_date:  normDate(get(row, 'Latest Action Date')),
      target_date:         normDate(get(row, 'Target Date')),
      deadline:            normDate(get(row, 'Deadline')),
      assignee_name:       get(row, 'Assignee Name'),
      estimate_hours:      normNumber(get(row, 'Estimate (hours)')),
    });
  }

  return { rows, warnings, skipped, seenTaskIds, headerOk: true };
}
