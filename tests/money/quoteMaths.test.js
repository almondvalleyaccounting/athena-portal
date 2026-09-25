import { describe, it, expect } from 'vitest';
import { computeQuote, monthlyFromAnnual, payrollFlat, directorTotal, lineItemsFor } from '../../src/lib/quoteMaths.js';
import { INITIAL_DEFAULTS as D } from '../../src/lib/defaults.js';

// The quote form's state as a new quote opens (hooks/useQuoteForm.js), with
// overrides. Accounts, confirmation statement and one director are on.
const newDir = (over = {}) => ({
  name: '', base: D.director_base, otherDividends: false, hasRentals: false, rentalProperties: 1,
  capitalGains: false, savingsIncome: false, otherSources: [], ...over,
});
const quote = (over = {}) => computeQuote({
  suFormation: false, suFormationQty: 1, suFormationRate: D.setup.formation_rate,
  suHmrc: false, suHmrcQty: 1, suHmrcRate: D.setup.hmrc_reg_rate, suRegFee: 0, suOthers: [],
  turnover: '',
  accEnabled: true, accType: 'trading', accRate: 900, accProperties: 1,
  accPropBase: D.property_base, accPropExtra: D.property_per_extra, accDormant: D.dormant_rate,
  staEnabled: false, staFee: D.sole_trader_accounts,
  csEnabled: true, csFee: D.confirmation_statement.fee,
  dtrEnabled: true, directors: [newDir()], addonRates: { ...D.director_addons },
  bkEnabled: false, bkHours: 8, bkRate: D.bookkeeping_rate, bkIncVat: true, bkVatAdj: 0,
  vatEnabled: false, vatFreq: 4, vatRate: D.vat_per_return,
  mtdEnabled: false, mtdFreq: 4, mtdRate: 35,
  prEnabled: false, prFlat: payrollFlat(D), prMonthlyEe: 0, prMonthlyEeRate: D.payroll.monthly_ee_rate,
  prWeeklyEe: 0, prWeeklyEeRate: D.payroll.weekly_ee_rate, prCis: 0, prCisRate: D.payroll.cis_rate,
  prP11d: 0, prP11dRate: D.payroll.p11d_rate,
  aeEnabled: false, aeFee: D.auto_enrolment.standard,
  modEnabled: false, modSwPrice: 20, modPayments: 0, modPaymentRate: 0.25, modRuns: 0, modRunRate: 5,
  maEnabled: false, maSets: 4, maRate: 158, rmEnabled: false, rmCount: 4, rmRate: 210,
  budEnabled: false, budBasic: false, budBasicRate: 1085, budAdvanced: false, budAdvancedRate: 3255,
  budReforecastQty: 0, budReforecastRate: 225,
  cfoEnabled: false, cfoDays: 1, cfoDayRate: 1680, roEnabled: false, roFee: D.registered_office,
  swId: 'none', dextEnabled: false, dextPrice: D.dext.monthly_price,
  ...over,
}, D);

describe('monthlyFromAnnual', () => {
  it('net = annual / 12, VAT = 20% of the rounded net, gross = net + VAT', () => {
    expect(monthlyFromAnnual(1000)).toEqual({ monthlyNet: 83.33, monthlyVat: 16.67, monthlyGross: 100 });
    expect(monthlyFromAnnual(0)).toEqual({ monthlyNet: 0, monthlyVat: 0, monthlyGross: 0 });
  });

  it('net + VAT = gross to the penny, across a range of annual fees', () => {
    for (let a = 0; a <= 20000; a += 7.31) {
      const m = monthlyFromAnnual(a);
      expect(Math.round((m.monthlyNet + m.monthlyVat) * 100)).toBe(Math.round(m.monthlyGross * 100));
    }
  });
});

describe('computeQuote — a typical limited company', () => {
  const q = quote({
    turnover: '120000',
    directors: [newDir({ otherDividends: true })],   // 240 + 15
    prEnabled: true, prMonthlyEe: 3,                  // 150 + 3 × 6 = 168 a month
    swId: 'qb_plus',                                  // £34 a month
  });

  it('prices each line', () => {
    expect(q.detectedBand.rate).toBe(900);
    expect(q.lines.map((l) => [l.id, l.annual])).toEqual([
      ['accounts_ct', 900], ['confirmation_statement', 110], ['directors_tax_return', 255], ['payroll', 2016],
    ]);
    expect(q.swAnnual).toBe(408);
  });

  it('totals: services + software, then monthly net / VAT / gross', () => {
    expect(q.annualServices).toBe(3281);
    expect(q.annualTotal).toBe(3689);
    expect([q.monthlyNet, q.monthlyVat, q.monthlyGross]).toEqual([307.42, 61.48, 368.9]);
  });

  it('flags nothing when everything is at standard', () => {
    expect(q.belowStandard).toEqual([]);
  });
});

describe('computeQuote — per service', () => {
  it('accounts: dormant, and property base + extras', () => {
    expect(quote({ accType: 'dormant' }).accAnnual).toBe(150);
    expect(quote({ accType: 'property', accProperties: 3 }).accAnnual).toBe(770);
  });

  it('payroll: weekly and CIS × 4.33 a month; P11Ds once a year', () => {
    const q = quote({ prEnabled: true, prWeeklyEe: 2, prCis: 1, prP11d: 2 });
    expect(q.prMoCalc).toBeCloseTo(150 + 2 * 1.8 * 4.33 + 1.8 * 4.33, 9);
    expect(q.prAnnual).toBeCloseTo(q.prMoCalc * 12 + 2 * 30, 9);
  });

  it('bookkeeping: hours × rate × 12, plus the VAT adjustment only when it includes VAT', () => {
    expect(quote({ bkEnabled: true, bkVatAdj: 100 }).bkAnnual).toBe(8 * 45 * 12 + 100);
    const noVat = quote({ bkEnabled: true, bkVatAdj: 100, bkIncVat: false });
    expect(noVat.bkAnnual).toBe(8 * 45 * 12);
    expect(noVat.lines.find((l) => l.id === 'bookkeeping')).toBeTruthy();
  });

  it('directors: base + each add-on, rentals per property', () => {
    const d = newDir({ otherDividends: true, hasRentals: true, rentalProperties: 2, capitalGains: true, savingsIncome: true, otherSources: [{ amount: 25 }] });
    expect(directorTotal(d, D.director_addons)).toBe(240 + 15 + 2 * 50 + 120 + 15 + 25);
  });

  it('setup fees are one-off and stay out of the monthly figures', () => {
    const q = quote({ suFormation: true, suFormationQty: 2, suHmrc: true, suRegFee: 12, suOthers: [{ amount: 30 }] });
    expect(q.setupTotal).toBe(2 * 100 + 50 + 12 + 30);
    expect(q.annualTotal).toBe(quote().annualTotal);
  });
});

describe('computeQuote — below-standard flags', () => {
  it('flags a fee more than 50p under standard, not one within it', () => {
    const q = quote({ turnover: '120000', accRate: 850, csFee: 109.6 });
    expect(q.belowStandard.map((b) => b.id)).toEqual(['accounts_ct']);
    expect(quote({ turnover: '120000', csFee: 100 }).belowStandard[0]).toMatchObject({ id: 'confirmation_statement', actual: 100, standard: 110 });
  });

  it('judges a director against standard add-on rates, whatever the quote used', () => {
    const q = quote({ directors: [newDir({ capitalGains: true })], addonRates: { ...D.director_addons, capital_gains: 60 } });
    expect(q.belowStandard[0]).toMatchObject({ id: 'directors_tax_return', actual: 300, standard: 360 });
  });

  it('never flags payroll, whatever it is priced at', () => {
    expect(quote({ prEnabled: true, prFlat: 1 }).belowStandard).toEqual([]);
  });
});

describe('lineItemsFor', () => {
  const q = quote({ swId: 'xero', dextEnabled: true });
  const items = lineItemsFor('Q1', { lines: q.lines, sw: q.sw, dextEnabled: true, dextPrice: 20 },
    [{ type: 'formation', description: 'Company formation', amount: 100 }]);

  it('each recurring line carries its annual and annual / 12', () => {
    const cs = items.find((i) => i.service_id === 'confirmation_statement');
    expect(cs).toMatchObject({ annual_amount: 110, monthly_amount: 9.17, is_recurring: true });
  });

  it('software is priced monthly; setup fees are one-off lines sorted after', () => {
    expect(items.find((i) => i.service_id === 'software_accounting')).toMatchObject({ annual_amount: 399, monthly_amount: 33.25 });
    expect(items.find((i) => i.service_id === 'software_dext')).toMatchObject({ annual_amount: 240, monthly_amount: 20 });
    expect(items.at(-1)).toMatchObject({ service_id: 'setup_formation', is_recurring: false, monthly_amount: 0, sort_order: 100 });
  });

  it('line items add up to the quote total, give or take rounding', () => {
    const recurring = items.filter((i) => i.is_recurring).reduce((s, i) => s + i.annual_amount, 0);
    expect(recurring).toBeCloseTo(q.annualTotal, 2);
  });
});
