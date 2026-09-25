import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ctOnAnnualProfit, classifyBalanceSheet, buildCashForecast } from '../../src/modules/planning/lib/cashflow.js';

describe('ctOnAnnualProfit', () => {
  it('19% small profits rate, 25% main rate', () => {
    expect(ctOnAnnualProfit(0)).toBe(0);
    expect(ctOnAnnualProfit(-5000)).toBe(0);
    expect(ctOnAnnualProfit(40000)).toBeCloseTo(7600, 6);
    expect(ctOnAnnualProfit(300000)).toBe(75000);
  });

  it('marginal relief between £50k and £250k', () => {
    // 100k × 25% − (250k − 100k) × 3/200 = 25,000 − 2,250
    expect(ctOnAnnualProfit(100000)).toBeCloseTo(22750, 6);
  });

  it('has no step at either threshold', () => {
    expect(ctOnAnnualProfit(50000)).toBeCloseTo(9500, 6);
    expect(ctOnAnnualProfit(50001)).toBeCloseTo(9500.265, 3);
    expect(ctOnAnnualProfit(249999)).toBeCloseTo(62499.735, 3);
    expect(ctOnAnnualProfit(250000)).toBe(62500);
  });
});

describe('classifyBalanceSheet', () => {
  it('keeps client money out of the firm\'s cash', () => {
    const bs = classifyBalanceSheet([
      { section: 'Bank', account_name: 'Current account', amount: 40000 },
      { section: 'Bank', account_name: 'Client account', amount: 90000 },
      { section: 'Other current liabilities', account_name: 'VAT Control', amount: 8000 },
      { section: 'Other current liabilities', account_name: 'Corporation Tax', amount: 12000 },
      { section: 'Other current liabilities', account_name: 'Something odd', amount: 1 },
    ]);
    expect(bs.cash).toBe(40000);
    expect(bs.clientMonies).toBe(90000);
    expect(bs.vat).toBe(8000);
    expect(bs.ct).toBe(12000);
    expect(bs.unclassified).toHaveLength(1);
  });
});

describe('buildCashForecast', () => {
  // Thursday 25 Sep 2026; AVA's year end is 30 Sep.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 25, 12)); });
  afterEach(() => { vi.useRealTimers(); });

  const scenario = { cash_floor_months: 6, fiscal_year_end_month: 9 };

  it('safe draw today = cash − VAT − CT − floor, floor = months × payroll', () => {
    const f = buildCashForecast({
      scenario, grossPayrollMonthly: 10000, contractedNetMonthly: 20000,
      bs: { cash: 150000, vat: 10000, ct: 5000 },
    });
    expect(f.floor).toBe(60000);
    expect(f.provisionsNow.vat).toBe(10000);
    expect(f.safeDrawNow).toBeCloseTo(150000 - 10000 - f.provisionsNow.ct - 60000, 6);
  });

  it('headline safe draw is the minimum headroom, never above today\'s', () => {
    // Drawings outrun income, so headroom falls across the year.
    const f = buildCashForecast({
      scenario, contractedNetMonthly: 10000, dividendsMonthly: 30000,
      bs: { cash: 400000, vat: 0, ct: 0 },
    });
    expect(f.safeDraw).toBe(Math.min(f.safeDrawNow, f.headroomMin));
    expect(f.safeDraw).toBeLessThan(f.safeDrawNow);
    expect(f.headroomMinDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('a ring-fenced VAT payment does not dent headroom', () => {
    const f = buildCashForecast({ scenario, bs: { cash: 100000, vat: 10000, ct: 0 } });
    expect(f.safeDrawNow).toBe(90000);
    expect(f.headroomMin).toBe(90000);
    // quarter to 30 Sep, paid 1 month + 7 days later
    const vat = f.events.find((e) => e.label.startsWith('VAT'));
    expect(vat.amount).toBe(-10000);
    expect(vat.date).toEqual(new Date(2026, 10, 7));
  });

  it('prior-year CT falls due at year end + 9 months + 1 day', () => {
    const f = buildCashForecast({ scenario, bs: { cash: 0, vat: 0, ct: 1000 } });
    expect(f.ctPayDate).toEqual(new Date(2026, 6, 1));   // year to 30 Sep 2025
    vi.setSystemTime(new Date(2026, 9, 5, 12));
    const g = buildCashForecast({ scenario, bs: { cash: 0, vat: 0, ct: 1000 } });
    expect(g.ctPayDate).toEqual(new Date(2027, 6, 1));   // year to 30 Sep 2026
  });

  it('in-year CT comes from actual YTD profit when there is one', () => {
    const f = buildCashForecast({
      scenario, contractedNetMonthly: 50000,          // modelled profit would be £600k/yr
      actualYtd: { profit: 100000, months: 12 },
      bs: { cash: 0, vat: 0, ct: 0 },
    });
    expect(f.assumptions.ctBasis).toBe('actual');
    expect(f.assumptions.inYearCtProvisionNow).toBeCloseTo(22750, 6);
  });
});
