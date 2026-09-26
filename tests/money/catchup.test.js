import { describe, it, expect } from 'vitest';
import { missedInvoices, catchupPeriod, catchupFor, catchupInvoiceLines, templateIntervalMonths } from '../../supabase/functions/_shared/catchup.ts';

describe('missedInvoices — a template on the 31st (130 of 141 live templates)', () => {
  // Next run 31 Oct 2026, so the template raised 31 Aug and 30 Sep before it.
  it('a go-live on the 1st of next month has missed nothing yet', () => {
    expect(missedInvoices('2026-10-31', '2026-10-01')).toEqual([]);
  });

  it('a go-live on 1 Sep has missed the 30 Sep invoice only', () => {
    expect(missedInvoices('2026-10-31', '2026-09-01')).toEqual(['2026-09-30']);
  });

  it('steps back month end to month end, through February and a leap year', () => {
    expect(missedInvoices('2026-10-31', '2026-08-01')).toEqual(['2026-08-31', '2026-09-30']);
    expect(missedInvoices('2024-04-30', '2024-01-01')).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });

  it('counts an invoice raised on the go-live date itself', () => {
    expect(missedInvoices('2026-10-31', '2026-09-30')).toEqual(['2026-09-30']);
  });
});

describe('missedInvoices — a template on a fixed day', () => {
  it('keeps its day number', () => {
    expect(missedInvoices('2026-10-07', '2026-08-01')).toEqual(['2026-08-07', '2026-09-07']);
  });

  it('clamps a day that a shorter month does not have', () => {
    // the 30th, not a month end in March: February has no 30th
    expect(missedInvoices('2026-03-30', '2026-01-01')).toEqual(['2026-01-30', '2026-02-28']);
  });

  it('crosses the year end', () => {
    expect(missedInvoices('2027-01-15', '2026-11-01')).toEqual(['2026-11-15', '2026-12-15']);
  });
});

describe('missedInvoices — nothing assumed', () => {
  it('an unreadable template (no next run) misses nothing', () => {
    expect(missedInvoices(null, '2026-01-01')).toEqual([]);
    expect(missedInvoices('31/10/2026', '2026-01-01')).toEqual([]);
  });

  it('a future go-live misses nothing', () => {
    expect(missedInvoices('2026-10-31', '2026-11-01')).toEqual([]);
  });

  it('never looks back more than 36 invoices', () => {
    expect(missedInvoices('2026-10-31', '2000-01-01')).toHaveLength(36);
  });
});

describe('catchupPeriod', () => {
  it('names the month, or the range', () => {
    expect(catchupPeriod([])).toBe('');
    expect(catchupPeriod(['2026-09-30'])).toBe('September 2026');
    expect(catchupPeriod(['2026-08-31', '2026-09-30'])).toBe('August 2026 to September 2026');
  });
});

describe('catchupFor', () => {
  const label = (s) => s.service_id;
  const staged = [
    { service_id: 'Accounts', monthly_amount: 75, pending_monthly_amount: 80 },     // +5
    { service_id: 'Payroll', monthly_amount: 150, pending_monthly_amount: 183.59 }, // +33.59
    { service_id: 'VAT', monthly_amount: 15, pending_monthly_amount: 15 },          // no change
    { service_id: 'Office', monthly_amount: 15, pending_monthly_amount: 10 },       // −5
  ];

  it('each line is its monthly increase × the invoices missed; unchanged lines drop out', () => {
    const c = catchupFor(staged, 2, label);
    expect(c.lines).toEqual([
      { service: 'Accounts', delta: 5, net: 10 },
      { service: 'Payroll', delta: 33.59, net: 67.18 },
      { service: 'Office', delta: -5, net: -10 },
    ]);
    expect([c.net, c.vat, c.gross]).toEqual([67.18, 13.44, 80.62]);
  });

  it('no missed invoices, no catch-up', () => {
    expect(catchupFor(staged, 0, label)).toEqual({ lines: [], net: 0, vat: 0, gross: 0 });
  });
});

describe('catchupInvoiceLines', () => {
  const { lines } = catchupFor([
    { service_id: 'Accounts', monthly_amount: 75, pending_monthly_amount: 80 },
    { service_id: 'Payroll', monthly_amount: 150, pending_monthly_amount: 183.59 },
    { service_id: 'Office', monthly_amount: 15, pending_monthly_amount: 10 },
  ], 2, (s) => s.service_id);
  const inv = catchupInvoiceLines(lines, 'August 2026 to September 2026', 2, 'client approval not received on time');

  it('bills increases only — a reduction is not netted off', () => {
    expect(inv.itemLines.map((l) => l.service)).toEqual(['Accounts', 'Payroll']);
    expect([inv.net, inv.vat, inv.gross]).toEqual([77.18, 15.44, 92.62]);
  });

  it('VAT per line, and the invoice totals are the sum of its lines', () => {
    expect(inv.itemLines[1]).toMatchObject({ net: 67.18, vat: 13.44, gross: 80.62, qty: 1, rate: 67.18 });
    expect(inv.vat).toBe(inv.itemLines.reduce((t, l) => Math.round((t + l.vat) * 100) / 100, 0));
  });

  it('says what it is for on the invoice', () => {
    expect(inv.itemLines[0].description).toBe(
      'Accounts: new fee from August 2026 to September 2026 (2 months at +£5.00), not yet billed — client approval not received on time');
  });
});

describe('quarterly and yearly templates (3 of 147 live)', () => {
  it('a yearly template steps back a year at a time', () => {
    // next run 31 Mar 2027, so the last one went out 31 Mar 2026
    expect(missedInvoices('2027-03-31', '2026-10-01', 12)).toEqual([]);
    expect(missedInvoices('2027-03-31', '2026-03-01', 12)).toEqual(['2026-03-31']);
    expect(missedInvoices('2026-09-30', '2024-09-01', 12)).toEqual(['2024-09-30', '2025-09-30']);
  });

  it('a quarterly template steps back three months at a time', () => {
    expect(missedInvoices('2026-10-30', '2026-06-01', 3)).toEqual(['2026-07-30']);
    expect(missedInvoices('2026-10-30', '2026-04-01', 3)).toEqual(['2026-04-30', '2026-07-30']);
  });

  it('the catch-up is the monthly increase × the months each missed invoice covers', () => {
    // £300 a year → £360 a year is +£5 a month; one missed yearly invoice owes £60
    const staged = [{ service_id: 'MTD', monthly_amount: 25, pending_monthly_amount: 30 }];
    expect(catchupFor(staged, 1, (s) => s.service_id, 12)).toMatchObject({ net: 60, vat: 12, gross: 72 });
    expect(catchupFor(staged, 2, (s) => s.service_id, 3)).toMatchObject({ net: 30, vat: 6, gross: 36 });
  });

  it('the invoice says how many of which invoices, at the per-invoice increase', () => {
    const staged = [{ service_id: 'MTD', monthly_amount: 25, pending_monthly_amount: 30 }];
    const yearly = catchupInvoiceLines(catchupFor(staged, 1, (s) => s.service_id, 12).lines, 'March 2026', 1, 'other', 12);
    expect(yearly.itemLines[0].description).toBe('MTD: new fee from March 2026 (1 annual invoice at +£60.00), not yet billed — other');
    const quarterly = catchupInvoiceLines(catchupFor(staged, 2, (s) => s.service_id, 3).lines, 'April 2026 to July 2026', 2, 'other', 3);
    expect(quarterly.itemLines[0].description).toBe('MTD: new fee from April 2026 to July 2026 (2 quarterly invoices at +£15.00), not yet billed — other');
  });
});

describe('templateIntervalMonths', () => {
  it('reads the interval every line on the template shares', () => {
    expect(templateIntervalMonths([{ cadence: 'monthly', cadence_months: 1 }, { cadence: 'monthly', cadence_months: 1 }])).toBe(1);
    expect(templateIntervalMonths([{ cadence: 'annual', cadence_months: 3 }])).toBe(3);
    expect(templateIntervalMonths([{ cadence: 'annual' }])).toBe(12);   // older rows without cadence_months
  });

  it('ignores one-off lines', () => {
    expect(templateIntervalMonths([{ cadence: 'annual', cadence_months: 12 }, { cadence: 'one_off' }])).toBe(12);
  });

  it('refuses to guess when lines disagree, or there is nothing recurring', () => {
    expect(templateIntervalMonths([{ cadence: 'monthly', cadence_months: 1 }, { cadence: 'annual', cadence_months: 12 }])).toBeNull();
    expect(templateIntervalMonths([{ cadence: 'one_off' }])).toBeNull();
  });
});
