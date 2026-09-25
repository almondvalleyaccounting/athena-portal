import { describe, it, expect } from 'vitest';
import { yearlyFeeOf, feeTotals, underBillingOf } from '../../src/modules/clients/feeRollup.js';
import { compareQuoteToBilling } from '../../src/lib/billingComparison.js';

describe('yearlyFeeOf', () => {
  it('uses annual_amount when present', () => {
    expect(yearlyFeeOf({ annual_amount: 1200, monthly_amount: 100 })).toBe(1200);
  });

  it('falls back to monthly × 12 when annual_amount is blank or zero', () => {
    expect(yearlyFeeOf({ annual_amount: 0, monthly_amount: 50 })).toBe(600);
    expect(yearlyFeeOf({ monthly_amount: 50 })).toBe(600);
  });
});

describe('feeTotals', () => {
  const rows = [
    {
      id: 1, status: 'active', qbo_recurring_txn_id: 'T1',
      services: [
        { cadence: 'monthly', monthly_amount: 100 },
        { cadence: 'monthly', monthly_amount: 25.5 },
        // annual line: monthly_amount holds the yearly fee ÷ 12
        { cadence: 'annual', monthly_amount: 9.17, annual_amount: 110 },
        { cadence: 'monthly', monthly_amount: 999, recurring_status: 'ending' },
        { cadence: 'monthly', monthly_amount: 999, approval_status: 'suggested' },
      ],
    },
    // no template, no approval: suggested, not counted
    { id: 2, status: 'active', services: [{ cadence: 'monthly', monthly_amount: 999 }] },
    { id: 3, status: 'inactive', qbo_recurring_txn_id: 'T3', services: [{ cadence: 'monthly', monthly_amount: 999 }] },
  ];

  it('counts approved, non-ending lines on active rows only', () => {
    expect(feeTotals(rows)).toEqual({ monthly: 125.5, annual: 110, hasTemplate: true });
  });

  it('reads an annual line as its yearly fee, not a twelfth of it', () => {
    expect(feeTotals([rows[0]]).annual).toBe(110);
  });
});

describe('underBillingOf', () => {
  it('flags a confirmation statement billed below the standard minimum', () => {
    expect(underBillingOf({ service_id: 'Confirmation Statement', cadence: 'monthly', monthly_amount: 5 }))
      .toEqual({ min: 110, under: 50 });
  });

  it('annualises an annual line from its yearly fee', () => {
    expect(underBillingOf({ description: 'Registered office', cadence: 'annual', annual_amount: 150, monthly_amount: 12.5 }))
      .toEqual({ min: 180, under: 30 });
  });

  it('leaves at-or-above-minimum, zero and unknown services alone', () => {
    expect(underBillingOf({ service_id: 'registered_office', cadence: 'monthly', monthly_amount: 15 })).toBeNull();
    expect(underBillingOf({ service_id: 'registered_office', cadence: 'monthly', monthly_amount: 0 })).toBeNull();
    expect(underBillingOf({ service_id: 'payroll', cadence: 'monthly', monthly_amount: 1 })).toBeNull();
  });
});

describe('compareQuoteToBilling', () => {
  const maps = [
    { service_id: 'accounts_ct', qbo_item_name: 'Accounts & Corporation Tax' },
    { service_id: 'payroll', qbo_item_name: 'Payroll' },
    { service_id: 'confirmation_statement', qbo_item_name: 'Confirmation Statement' },
  ];
  const quote = [
    { service_id: 'accounts_ct', annual_amount: 900, is_recurring: true },
    { service_id: 'payroll', annual_amount: 1800, is_recurring: true },
    { service_id: 'setup', annual_amount: 100, is_recurring: false },
  ];
  const live = [
    { service_id: 'Accounts:Accounts & Corporation Tax', monthly_amount: 70 },
    // a pre-rename QBO name still lines up
    { service_id: 'Annual Confirmation Statement', annual_amount: 110 },
    { service_id: 'Payroll', monthly_amount: 150.02 },
  ];
  const r = compareQuoteToBilling(quote, live, maps);
  const row = (id) => r.rows.find((x) => x.id === id);

  it('lines up quote and live per service, recurring only', () => {
    expect(row('accounts_ct')).toMatchObject({ quoteAnnual: 900, liveAnnual: 840, deltaAnnual: 60, status: 'changed' });
    expect(row('confirmation_statement')).toMatchObject({ quoteAnnual: 0, liveAnnual: 110, status: 'removed' });
    expect(row('setup')).toBeUndefined();
  });

  it('treats a difference of 50p a year or less as the same', () => {
    expect(row('payroll')).toMatchObject({ deltaAnnual: -0.24, status: 'same' });
  });

  it('totals tie to the rows and the monthlies are the annuals / 12', () => {
    const t = r.totals;
    expect(t.quoteAnnual).toBe(2700);
    expect(t.liveAnnual).toBe(2750.24);
    expect(t.deltaAnnual).toBe(-50.24);
    expect(t.liveMonthly).toBe(229.19);
    expect(t.pct).toBe(-1.8);
  });
});
