import { describe, it, expect } from 'vitest';
import { standardFor, priceBuild, builderDefaults, buildServiceResolver } from '../../src/modules/billing/standardPricing.js';
import { INITIAL_DEFAULTS as D } from '../../src/lib/defaults.js';

const trading = (turnover) => ({ turnover, accountsType: 'trading' });

describe('standardFor — accounts bands', () => {
  it('prices each band as its annual rate / 12', () => {
    expect(standardFor('accounts_ct', trading(50000), D).monthly).toBe(62.5);   // 750
    expect(standardFor('accounts_ct', trading(120000), D).monthly).toBe(75);    // 900
    expect(standardFor('accounts_ct', trading(5000000), D).monthly).toBe(200);  // 2400, open-ended top band
  });

  it('puts a turnover on a band boundary in the lower band', () => {
    expect(standardFor('accounts_ct', trading(90000), D).monthly).toBe(62.5);
    expect(standardFor('accounts_ct', trading(90001), D).monthly).toBe(75);
  });

  it('asks for turnover rather than guessing', () => {
    expect(standardFor('accounts_ct', trading(''), D)).toEqual({ missing: 'turnover' });
  });

  it('prices dormant and property companies off their own rates', () => {
    expect(standardFor('accounts_ct', { accountsType: 'dormant' }, D).monthly).toBe(12.5);
    // 650 base + 2 extra × 60 = 770 a year
    expect(standardFor('accounts_ct', { accountsType: 'property', properties: 3 }, D).monthly).toBe(64.17);
    // zero or blank properties still means one
    expect(standardFor('property_accounts', { properties: 0 }, D).monthly).toBe(54.17);
  });
});

describe('standardFor — per-unit services', () => {
  it('directors: count × base return', () => {
    expect(standardFor('directors_tax_return', { directors: 2 }, D).monthly).toBe(40);
    expect(standardFor('directors_tax_return', { directors: '' }, D)).toEqual({ missing: 'directors' });
  });

  it('VAT: 4 returns × rate', () => {
    expect(standardFor('vat_returns', {}, D).monthly).toBe(15);
  });

  it('payroll: ceil(BrightPay per client × markup) + payslips, weekly × 4.33', () => {
    // flat = ceil(4500 / 45 × 1.5) = 150; 3 monthly × 6 = 18; 2 weekly × 1.80 × 4.33 = 15.588
    const r = standardFor('payroll', { monthlyEmployees: 3, weeklyEmployees: 2 }, D);
    expect(r.monthly).toBe(183.59);
  });

  it('payroll with zero staff is the flat fee, blank staff is unknown', () => {
    expect(standardFor('payroll', { monthlyEmployees: 0, weeklyEmployees: '' }, D).monthly).toBe(150);
    expect(standardFor('payroll', { monthlyEmployees: '', weeklyEmployees: '' }, D)).toEqual({ missing: 'employees' });
  });

  it('has no standard for judgement-priced services', () => {
    expect(standardFor('bookkeeping_vat', {}, D)).toBeNull();
    expect(standardFor('fractional_cfo', {}, D)).toBeNull();
  });
});

describe('BUILDERS', () => {
  it('management accounts: sets × rate / 12, rounded to the penny', () => {
    expect(priceBuild('management_accounts', { sets: 4, rate: 158 }, D).monthly).toBe(52.67);
  });

  it('bookkeeping is hours × rate, already monthly', () => {
    expect(priceBuild('bookkeeping_vat', { hours: 8, rate: 45 }, D).monthly).toBe(360);
  });

  it('the payroll builder at its defaults agrees with standardFor', () => {
    const v = { ...builderDefaults('payroll', D), monthly: 3, weekly: 2 };
    expect(v.base).toBe(150);
    expect(priceBuild('payroll', v, D).monthly)
      .toBe(standardFor('payroll', { monthlyEmployees: 3, weeklyEmployees: 2 }, D).monthly);
  });

  it('the VAT builder at its defaults agrees with standardFor', () => {
    expect(priceBuild('vat_returns', builderDefaults('vat_returns', D), D).monthly)
      .toBe(standardFor('vat_returns', {}, D).monthly);
  });
});

describe('buildServiceResolver', () => {
  const resolve = buildServiceResolver([
    { service_id: 'accounts_ct', qbo_item_name: 'Accounts & Corporation Tax' },
    { service_id: 'auto_enrolment', qbo_item_name: 'Payroll' },
    { service_id: 'payroll', qbo_item_name: 'Payroll' },
  ]);

  it('matches a fully-qualified QBO name on its leaf', () => {
    expect(resolve('Accounts:Accounts & Corporation Tax')).toBe('accounts_ct');
  });

  it('prefers the primary service when two map to one item', () => {
    expect(resolve('Payroll')).toBe('payroll');
  });

  it('returns null for an unmapped item', () => {
    expect(resolve('Something else')).toBeNull();
  });
});
