import { describe, it, expect } from 'vitest';
import { portfolioWindow } from '../../src/modules/client-dashboard/portfolioSignals.js';
import { shiftMonthsBack, computePeriod } from '../../src/modules/client-dashboard/dashboardData.js';
import { buildStatement, netRow } from '../../src/modules/client-dashboard/projectionEngine.js';
import { toPence, fromPence } from '../../src/modules/forecast/lib/engine.js';
import { occupancyOnCurve } from '../../src/modules/forecast/lib/occupancy.js';

const OCT = 9; // fiscal year starting October (30 Sep year end)

describe('shiftMonthsBack', () => {
  it('keeps a month end on a month end', () => {
    expect(shiftMonthsBack('2026-08-31', 6)).toBe('2026-02-28');
    expect(shiftMonthsBack('2025-02-28', 12)).toBe('2024-02-29');
  });

  it('keeps other days, clamped to the target month', () => {
    expect(shiftMonthsBack('2026-03-15', 1)).toBe('2026-02-15');
    expect(shiftMonthsBack('2026-03-30', 1)).toBe('2026-02-28');
  });
});

// Each expectation below is also what sql/294 portfolio_default_window()
// returns for the same day and year end. If this file changes, that must too.
describe('portfolioWindow(ytdLastMonth) — must match sql/294', () => {
  it('mid-year', () => {
    const w = portfolioWindow('ytdLastMonth', new Date(2026, 8, 25), OCT);
    expect(w).toMatchObject({
      plStart: '2025-10-01', plEnd: '2026-08-31',
      cmpStart: '2024-10-01', cmpEnd: '2025-08-31',
      chartStart: '2024-09-01', chartEnd: '2026-08-31',
      asAt: '2026-08-31', arPrevDate: '2026-07-31',
    });
    expect(w.keys.pl).toBe('pl_cmp#2025-10-01_2026-08-31');
  });

  it('first month of a new year is the whole year just finished', () => {
    const w = portfolioWindow('ytdLastMonth', new Date(2026, 9, 10), OCT);
    expect(w.plStart).toBe('2025-10-01');
    expect(w.plEnd).toBe('2026-09-30');
  });

  it('comparative ends on 29 Feb in a leap year', () => {
    const w = portfolioWindow('ytdLastMonth', new Date(2025, 2, 10), OCT);
    expect(w).toMatchObject({ plStart: '2024-10-01', plEnd: '2025-02-28', cmpStart: '2023-10-01', cmpEnd: '2024-02-29' });
  });

  it('April year start', () => {
    const w = portfolioWindow('ytdLastMonth', new Date(2026, 8, 25), 3);
    expect(w).toMatchObject({ plStart: '2026-04-01', plEnd: '2026-08-31', cmpStart: '2025-04-01', cmpEnd: '2025-08-31' });
  });
});

describe('computePeriod', () => {
  it('last fiscal year is the most recently completed one', () => {
    const p = computePeriod('lastFiscalYear', new Date(2026, 8, 25), OCT);
    expect(p).toMatchObject({ plStart: '2024-10-01', plEnd: '2025-09-30', priorStart: '2023-10-01', priorEnd: '2024-09-30' });
  });

  it('the prior period for YTD is the same number of months immediately before', () => {
    const p = computePeriod('ytdLastMonth', new Date(2026, 8, 25), OCT);   // 11 months
    expect(p).toMatchObject({ priorStart: '2024-11-01', priorEnd: '2025-09-30' });
  });
});

describe('buildStatement', () => {
  const q1 = { startKey: '2026-01', endKey: '2026-03', months: ['2026-01', '2026-02', '2026-03'] };
  const actual = {
    income: { '2026-01': 1000, '2026-02': 1100, '2026-03': 9999 },
    overheads: { '2026-01': 400, '2026-02': 400 },
    debtors: { '2026-01': 5000, '2026-02': 6000 },
  };
  const forecast = {
    income: { '2026-03': 1200 },
    overheads: { '2026-03': 450 },
    debtors: { '2026-03': 7000 },
  };
  const { rows, status } = buildStatement({
    buckets: [q1], actual, forecast, cutoff: '2026-02', order: ['income', 'overheads', 'debtors'],
  });
  const v = (cat) => rows.find((r) => r.category === cat).values[0];

  it('stitches at the cut-off: actuals up to it, forecast after', () => {
    expect(status).toEqual(['mixed']);
    expect(v('income')).toBe(3300);      // 1000 + 1100 actual, 1200 forecast — not 9999
  });

  it('balance-sheet lines are stocks: the quarter-end figure, not a sum', () => {
    expect(v('debtors')).toBe(7000);
  });

  it('net profit is income minus costs', () => {
    expect(netRow(rows).values[0]).toBe(3300 - 1250);
  });
});

describe('forecast pence', () => {
  it('converts pounds to whole pence and back', () => {
    expect(toPence(1234.56)).toBe(123456);
    expect(toPence(0.1 + 0.2)).toBe(30);
    expect(fromPence(123456)).toBe(1234.56);
  });
});

describe('occupancyOnCurve', () => {
  const curve = { start: 40, target: 85, ramp: 6 };

  it('is 0 before opening, start on opening, target once ramped', () => {
    expect(occupancyOnCurve(curve, 3, 2)).toBe(0);
    expect(occupancyOnCurve(curve, 3, 3)).toBe(40);
    expect(occupancyOnCurve(curve, 3, 9)).toBe(85);
    expect(occupancyOnCurve(curve, 3, 30)).toBe(85);
  });

  it('eases out: rises every month, fastest first', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6].map((p) => occupancyOnCurve(curve, 0, p));
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(steps.every((s) => s > 0)).toBe(true);
    expect(steps.every((s, i) => i === 0 || s < steps[i - 1])).toBe(true);
  });
});
