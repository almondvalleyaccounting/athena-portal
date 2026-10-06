// Priority board capacity queue (sql/349). Pure: no database access.
//
// One person's column, in the order they will work it. Walking down it, each
// job uses its preparation hours out of the hours a day that person gives to
// this kind of work (weekly hours ÷ their working days; a day off is 0, a
// half day half). The internal review date is a week after preparation
// finishes (the chain has Prepare = review − 7 days), rolled to a weekday,
// and never later than the statutory date less the buffer: a job the queue
// cannot reach in time is clamped to that limit and flagged.

import { parseISO, toISO, addDays, workingSet, roll, minusWorkingDays } from "./workflow.ts";

export interface QueueJob {
  key: string;
  prepHours: number;
  prepDone: boolean;     // preparation finished: nothing left to queue
  reviewDone: boolean;   // past internal review: off the queue entirely
  statutory: string | null;
}

export interface QueueOpts {
  today: string;
  weeklyHours: number;
  workingDays: string | null;
  /** days off: ISO date -> 1 (whole day) or 0.5 (half day) */
  daysOff: Record<string, number>;
  bufferWd: number;
}

export interface QueueSlot {
  key: string;
  review_date: string | null;
  prep_from: string | null;
  prep_to: string | null;
  limit: string | null;      // statutory less the buffer
  capped: boolean;           // the queue would have put it past the limit
  overdue: boolean;          // the limit is already behind us
}

export const REVIEW_GAP_DAYS = 7;
const WEEKDAYS = workingSet(null);

export function runQueue(jobs: QueueJob[], o: QueueOpts): QueueSlot[] {
  const set = workingSet(o.workingDays);
  const perDay = o.weeklyHours > 0 ? o.weeklyHours / set.size : 0;
  const today = parseISO(o.today);
  const avail = (d: Date) => {
    if (!set.has(["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getUTCDay()])) return 0;
    return perDay * (1 - (o.daysOff[toISO(d)] || 0));
  };
  let cursor = today;
  let left = avail(cursor);
  const out: QueueSlot[] = [];

  for (const j of jobs) {
    const limit = j.statutory ? minusWorkingDays(parseISO(j.statutory), o.bufferWd) : null;
    const base = { key: j.key, limit: limit ? toISO(limit) : null, overdue: !!limit && limit < today };
    if (j.reviewDone) { out.push({ ...base, review_date: null, prep_from: null, prep_to: null, capped: false }); continue; }

    let review: Date | null = null;
    let from: Date | null = null, to: Date | null = null;
    if (j.prepDone) {
      // Ready for review now: a couple of days for the reviewer to pick it up.
      review = roll(addDays(today, 2), WEEKDAYS, 1);
    } else if (perDay > 0) {
      let need = Math.max(0, j.prepHours || 0);
      for (let guard = 0; guard < 2000 && left <= 1e-9; guard++) { cursor = addDays(cursor, 1); left = avail(cursor); }
      from = cursor; to = cursor;
      for (let guard = 0; need > 1e-9 && guard < 2000; guard++) {
        if (left <= 1e-9) { cursor = addDays(cursor, 1); left = avail(cursor); continue; }
        const take = Math.min(need, left);
        need -= take; left -= take; to = cursor;
      }
      review = roll(addDays(to, REVIEW_GAP_DAYS), WEEKDAYS, 1);
    }

    let capped = false;
    if (limit && (!review || review > limit)) { review = limit; capped = true; }
    out.push({ ...base, review_date: review ? toISO(review) : null, prep_from: from ? toISO(from) : null, prep_to: to ? toISO(to) : null, capped });
  }
  return out;
}

/** Expand holiday rows into a per-day map for runQueue. */
export function daysOffMap(rows: Array<{ date_from: string; date_to: string; half_day: boolean | null }>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    let d = parseISO(r.date_from);
    const end = parseISO(r.date_to || r.date_from);
    for (let i = 0; d <= end && i < 400; i++, d = addDays(d, 1)) m[toISO(d)] = Math.max(m[toISO(d)] || 0, r.half_day ? 0.5 : 1);
  }
  return m;
}
