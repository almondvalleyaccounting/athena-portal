import { describe, it, expect } from 'vitest';
import { addMonthsClamped, addMonthsKeepMonthEnd } from '../../src/lib/monthMath.js';

// What setUTCMonth() used to give for the same inputs is noted beside each
// case: every one of those rolled into the following month.

describe('addMonthsClamped — Postgres interval semantics', () => {
  it('clamps to a shorter month instead of rolling over', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');   // was 2026-03-03
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');   // leap year
    expect(addMonthsClamped('2026-10-31', -1)).toBe('2026-09-30');  // was 2026-10-01
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');  // was 2026-03-03
  });

  it('keeps the day number, even on a month end', () => {
    expect(addMonthsClamped('2026-04-30', 1)).toBe('2026-05-30');
    expect(addMonthsClamped('2026-02-28', 1)).toBe('2026-03-28');
    expect(addMonthsClamped('2026-03-15', -1)).toBe('2026-02-15');
  });

  // Team's Unplanned drawer and Plan the Job's flag: today + 7 months, which
  // must match `current_date + interval '7 months'` in v_work_signals (sql/305)
  // so the list behind a count holds the same jobs as the count.
  it('the seven-month unplanned window matches the SQL interval', () => {
    expect(addMonthsClamped('2026-07-31', 7)).toBe('2027-02-28');   // was 2027-03-03
    expect(addMonthsClamped('2026-08-30', 7)).toBe('2027-03-30');
    expect(addMonthsClamped('2027-07-29', 7)).toBe('2028-02-29');
  });

  it('crosses years in both directions', () => {
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsClamped('2026-01-31', -2)).toBe('2025-11-30');
    expect(addMonthsClamped('2026-05-31', -17)).toBe('2024-12-31');
  });
});

describe('addMonthsKeepMonthEnd — year ends and dates worked from them', () => {
  // Plan the Job's nudge flag: a month past the year end.
  it('a month after a month-end year end is the next month end', () => {
    expect(addMonthsKeepMonthEnd('2026-01-31', 1)).toBe('2026-02-28');  // was 2026-03-03
    expect(addMonthsKeepMonthEnd('2026-03-31', 1)).toBe('2026-04-30');  // was 2026-05-01
    expect(addMonthsKeepMonthEnd('2026-08-31', 1)).toBe('2026-09-30');  // was 2026-10-01
    expect(addMonthsKeepMonthEnd('2026-09-30', 1)).toBe('2026-10-31');
    expect(addMonthsKeepMonthEnd('2026-04-30', 1)).toBe('2026-05-31');
    expect(addMonthsKeepMonthEnd('2027-01-31', 1)).toBe('2027-02-28');
  });

  // Ready Now's fallback: period end = Companies House deadline − 9 months.
  it('nine months back from a Companies House deadline is the year end', () => {
    expect(addMonthsKeepMonthEnd('2026-11-30', -9)).toBe('2026-02-28'); // YE 28 Feb; was 2026-03-02
    expect(addMonthsKeepMonthEnd('2028-11-30', -9)).toBe('2028-02-29'); // YE 29 Feb, leap year
    expect(addMonthsKeepMonthEnd('2026-09-30', -9)).toBe('2025-12-31'); // YE 31 Dec; was 2025-12-30
    expect(addMonthsKeepMonthEnd('2027-02-28', -9)).toBe('2026-05-31'); // YE 31 May; was 2026-05-28
    expect(addMonthsKeepMonthEnd('2026-12-31', -9)).toBe('2026-03-31'); // YE 31 Mar
    expect(addMonthsKeepMonthEnd('2026-06-30', -9)).toBe('2025-09-30'); // YE 30 Sep
  });

  it('and nine months forward from the year end is the deadline', () => {
    for (const ye of ['2026-02-28', '2025-12-31', '2026-05-31', '2026-03-31', '2025-09-30']) {
      expect(addMonthsKeepMonthEnd(addMonthsKeepMonthEnd(ye, 9), -9)).toBe(ye);
    }
  });

  it('leaves other days alone, clamped to a shorter month', () => {
    expect(addMonthsKeepMonthEnd('2026-03-15', 1)).toBe('2026-04-15');
    expect(addMonthsKeepMonthEnd('2026-03-30', -1)).toBe('2026-02-28');
    expect(addMonthsKeepMonthEnd('2026-05-30', 1)).toBe('2026-06-30');
  });
});

describe('input handling', () => {
  it('zero months is the same date', () => {
    expect(addMonthsClamped('2026-01-31', 0)).toBe('2026-01-31');
    expect(addMonthsKeepMonthEnd('2026-02-28', 0)).toBe('2026-02-28');
  });

  it('reads the date part of a timestamp', () => {
    expect(addMonthsClamped('2026-01-31T12:00:00Z', 1)).toBe('2026-02-28');
  });

  it('returns null for anything that is not a date', () => {
    for (const bad of [null, undefined, '', '31/01/2026', 'soon']) {
      expect(addMonthsClamped(bad, 1)).toBeNull();
      expect(addMonthsKeepMonthEnd(bad, 1)).toBeNull();
    }
  });
});
