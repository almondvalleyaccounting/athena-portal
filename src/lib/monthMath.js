// Month arithmetic on ISO dates (YYYY-MM-DD), in whole calendar days: no time
// zones, and no Date rollover. Pure — tested in tests/dates/monthMath.test.js.
//
// setUTCMonth() pushes a day the target month doesn't have into the next one:
// 31 Jan + 1 month comes out as 3 March, 31 Oct − 1 month as 1 October. Year
// ends in this app are month ends (all 251 accounts jobs on 2026-09-26), so
// that bug lands on almost every date that matters. Neither function here
// rolls over. Both return null for anything that isn't an ISO date.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

// Last day of a month; `month` is 1-12, and may run outside that range.
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function shift(iso, n, keepMonthEnd) {
  const m = ISO_DATE.exec(String(iso ?? ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1 + Math.trunc(n || 0), 1));
  const ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
  const last = lastDay(ty, tm);
  const day = keepMonthEnd && d === lastDay(y, mo) ? last : Math.min(d, last);
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The day number is kept, clamped to a shorter month: 31 Jan + 1 → 28 Feb,
// 30 Apr + 1 → 30 May. This is Postgres's `date + interval 'n months'`, so use
// it for a window measured from today where SQL counts the same thing with an
// interval (v_work_signals' seven-month unplanned window, sql/305).
export function addMonthsClamped(iso, n) {
  return shift(iso, n, false);
}

// As above, except a month end stays a month end: 30 Apr + 1 → 31 May,
// 30 Nov − 9 → 28 Feb, 30 Sep − 9 → 31 Dec. Use it for year ends and the
// dates worked from them: Companies House counts nine months end to end
// (YE 28 Feb → 30 Nov, YE 31 Dec → 30 Sep). Same rule as missedInvoices() in
// supabase/functions/_shared/catchup.ts and shiftMonthsBack() in
// client-dashboard/dashboardData.js. The one ambiguity: a fixed day that
// happens to be its month's last (30 Apr on a 30th-of-the-month schedule)
// reads as a month end.
export function addMonthsKeepMonthEnd(iso, n) {
  return shift(iso, n, true);
}
