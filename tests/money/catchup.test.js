import { describe, it, expect } from 'vitest';
import { missedInvoices, catchupPeriod, catchupFor, catchupInvoiceLines } from '../../supabase/functions/_shared/catchup.ts';

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
