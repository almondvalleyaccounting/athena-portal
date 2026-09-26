import { describe, it, expect } from 'vitest';
import { addMonths, computeChain, parseISO, toISO } from '../../supabase/functions/_shared/workflow.ts';
import { addMonthsKeepMonthEnd } from '../../src/lib/monthMath.js';

// The job-plan and job-plan-tick edge functions date every stage with this
// addMonths. It used to clamp only, so a year end on the last day of a short
// month put its month-offset stages 1-3 days early.
const plus = (iso, n) => toISO(addMonths(parseISO(iso), n));

describe('workflow addMonths', () => {
  it('keeps a month-end year end on month ends', () => {
    expect(plus('2025-09-30', 3)).toBe('2025-12-31');   // records in; was 2025-12-30
    expect(plus('2025-09-30', 6)).toBe('2026-03-31');   // meeting / send; was 2026-03-30
    expect(plus('2026-02-28', 3)).toBe('2026-05-31');   // was 2026-05-28
    expect(plus('2026-02-28', 7)).toBe('2026-09-30');   // file at CH; was 2026-09-28
    expect(plus('2026-02-28', 9)).toBe('2026-11-30');   // CT reminder base; was 2026-11-28
    expect(plus('2026-03-31', 7)).toBe('2026-10-31');
    expect(plus('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('clamps any other day, and never rolls into the next month', () => {
    expect(plus('2026-03-30', -1)).toBe('2026-02-28');
    expect(plus('2026-05-30', 1)).toBe('2026-06-30');
    expect(plus('2026-03-15', 13)).toBe('2027-04-15');
    expect(plus('2026-10-31', -1)).toBe('2026-09-30');
  });

  it('keeps the time of day', () => {
    expect(addMonths(new Date('2026-01-31T12:00:00Z'), 1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
  });

  it('agrees with the frontend helper over every month end and offset used', () => {
    for (let y = 2025; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        const ye = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        for (const n of [-9, -1, 1, 3, 6, 7, 9]) expect(plus(ye, n)).toBe(addMonthsKeepMonthEnd(ye, n));
      }
    }
  });
});

// The nightly tick nudges when addMonths(period_end, 1) <= today, which is the
// same test Plan the Job uses for its nudge flag.
describe('the nudge date is the same in the tick and on screen', () => {
  const nudgeDue = (ye, today) => addMonths(parseISO(ye), 1) <= parseISO(today);
  it('YE 31 Jan is due on 28 Feb, not 3 March', () => {
    expect(nudgeDue('2026-01-31', '2026-02-27')).toBe(false);
    expect(nudgeDue('2026-01-31', '2026-02-28')).toBe(true);
  });
  it('YE 30 Sep is due on 31 Oct', () => {
    expect(nudgeDue('2026-09-30', '2026-10-30')).toBe(false);
    expect(nudgeDue('2026-09-30', '2026-10-31')).toBe(true);
    expect(addMonthsKeepMonthEnd('2026-09-30', 1)).toBe('2026-10-31');
  });
});

describe('computeChain dates a year-end stage to the month end', () => {
  const stage = {
    seq: 1, key: 'records_in', label: 'Records in', kind: 'milestone', owner_role: 'client',
    anchor: 'ye', anchor_stage_key: null, offset_months: 3, offset_days: 0,
    gate_stage_key: null, done_signal: 'manual', min_gap_stage_key: null, min_gap_days: null,
    hard_limit: null, hard_limit_buffer_wd: 10, hours: null, requires: null,
  };
  const ctx = {
    periodEnd: '2025-09-30', chDeadline: '2026-06-30', ctDeadline: '2026-07-01',
    hasMeeting: false, booksWithUs: false, owners: {}, workingDays: {},
  };
  it('YE 30 Sep + 3 months is Wed 31 Dec', () => {
    const [m] = computeChain([stage], ctx);
    expect(m.due_date).toBe('2025-12-31');
  });
});
