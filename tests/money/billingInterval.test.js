import { describe, it, expect } from 'vitest';
import {
  monthlyFactor, invoicesPerYear, monthlyFromInvoice, annualFromInvoice, perInvoiceFor,
} from '../../supabase/functions/_shared/billing-interval.ts';

const r2 = (n) => Math.round(n * 100) / 100;
const MONTHLY = monthlyFactor({ IntervalType: 'Monthly', NumInterval: 1 });
const QUARTERLY = monthlyFactor({ IntervalType: 'Monthly', NumInterval: 3 });
const YEARLY = monthlyFactor({ IntervalType: 'Yearly', NumInterval: 1 });

describe('monthlyFactor', () => {
  it('reads the QBO schedule', () => {
    expect(MONTHLY).toBe(1);
    expect(QUARTERLY).toBeCloseTo(1 / 3, 12);
    expect(YEARLY).toBeCloseTo(1 / 12, 12);
    expect(monthlyFactor({ IntervalType: 'Weekly', NumInterval: 2 })).toBeCloseTo(26 / 12, 12);
  });

  it('no schedule, or no interval count, reads as monthly', () => {
    expect(monthlyFactor(undefined)).toBe(1);
    expect(monthlyFactor({ IntervalType: 'Monthly' })).toBe(1);
  });

  it('invoices a year', () => {
    expect(invoicesPerYear(MONTHLY)).toBe(12);
    expect(invoicesPerYear(QUARTERLY)).toBeCloseTo(4, 12);
    expect(invoicesPerYear(YEARLY)).toBeCloseTo(1, 12);
  });
});

describe('template → Athena (qbo-pull)', () => {
  it('a £500 yearly template is £41.67 a month and £500 a year, not £500.04', () => {
    expect(monthlyFromInvoice(500, YEARLY)).toBe(41.67);
    expect(annualFromInvoice(500, YEARLY)).toBe(500);
  });

  it('a £100 quarterly template is £400 a year, not £399.96', () => {
    expect(monthlyFromInvoice(100, QUARTERLY)).toBe(33.33);
    expect(annualFromInvoice(100, QUARTERLY)).toBe(400);
  });

  it('monthly templates come out exactly as before (annual = monthly × 12)', () => {
    for (let pence = 0; pence <= 500000; pence += 137) {
      const amt = pence / 100;
      const oldMonthly = Math.round(amt * MONTHLY * 100) / 100;
      expect(monthlyFromInvoice(amt, MONTHLY)).toBe(oldMonthly);
      expect(annualFromInvoice(amt, MONTHLY)).toBe(Math.round(oldMonthly * 12 * 100) / 100);
    }
  });
});

describe('Athena → template (qbo-push-recurring)', () => {
  it('without an exact amount, the push is exactly what it always was', () => {
    for (const f of [MONTHLY, QUARTERLY, YEARLY, monthlyFactor({ IntervalType: 'Weekly', NumInterval: 1 })]) {
      for (let pence = 0; pence <= 200000; pence += 97) {
        const m = pence / 100;
        expect(perInvoiceFor(m, f)).toBe(Math.round(m * (1 / f) * 100) / 100);
      }
    }
  });

  it('this is the round trip being fixed: £1,000 a year staged as £83.33 a month', () => {
    expect(perInvoiceFor(83.33, YEARLY)).toBe(999.96);
  });

  it('an exact per-invoice amount that agrees with the monthly figure goes on the invoice', () => {
    expect(perInvoiceFor(83.33, YEARLY, 1000)).toBe(1000);
    expect(perInvoiceFor(41.67, YEARLY, 500)).toBe(500);
    expect(perInvoiceFor(33.33, QUARTERLY, 100)).toBe(100);
    expect(perInvoiceFor(83.33, YEARLY, '1000')).toBe(1000);  // jsonb may hand it back as text
  });

  it('a stale exact amount — the monthly figure has since moved — is ignored', () => {
    // staged at £1,000 a year, then someone changed the monthly to £90
    expect(perInvoiceFor(90, YEARLY, 1000)).toBe(1080);
  });

  it('an exact amount at the wrong interval is ignored', () => {
    // £1,000 is a yearly figure; on a monthly template it can't be £83.33
    expect(perInvoiceFor(83.33, MONTHLY, 1000)).toBe(83.33);
  });

  it('blank, negative or junk exact amounts are ignored', () => {
    for (const bad of [null, undefined, '', 'abc', -1000]) {
      expect(perInvoiceFor(83.33, YEARLY, bad)).toBe(999.96);
    }
  });

  it('pull then push puts a template back exactly as it was', () => {
    for (const [amt, f] of [[500, YEARLY], [270, YEARLY], [75, QUARTERLY], [100, QUARTERLY], [1234.56, MONTHLY]]) {
      const monthly = monthlyFromInvoice(amt, f);
      expect(perInvoiceFor(monthly, f, amt)).toBe(r2(amt));
    }
  });
});
