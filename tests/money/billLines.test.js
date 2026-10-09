import { describe, it, expect } from 'vitest';
import {
  applyCalc, blankLine, buildLinesPayload, evalArithmetic, fmtNum, invoiceToLines, splitOf,
} from '../../src/modules/billing/billLinesMath.js';

// The bill line editor's maths, shared by the Billing page and "+ Create"
// (moved out of BillingPage.jsx on 2026-10-09). These pin today's behaviour.

const typed = (...steps) => steps.reduce((l, [f, v]) => applyCalc(l, f, v), blankLine());

describe('Qty × Rate = Amount', () => {
  it('an amount on a fresh line is 1 × that amount, with VAT at 20%', () => {
    const l = typed(['net', '600']);
    expect(l).toMatchObject({ qty: '1', rate: '600', net: '600', vat: '120.00', gross: '720.00' });
  });
  it('quantity and rate work out the amount', () => {
    const l = typed(['qty', '12'], ['rate', '50']);
    expect(l).toMatchObject({ net: '600', vat: '120.00', gross: '720.00' });
  });
  it('a rate typed after an amount works out the quantity', () => {
    const l = typed(['net', '600'], ['rate', '50']);
    expect(l.qty).toBe('12');
  });
  it('a rate against a blank quantity means one of them', () => {
    const l = typed(['rate', '75']);
    expect(l).toMatchObject({ qty: '1', net: '75' });
  });
  it('clearing the amount clears the rate derived from it', () => {
    const l = typed(['net', '600'], ['net', '']);
    expect(l).toMatchObject({ net: '', rate: '', gross: '' });
  });
});

describe('sums typed into a box', () => {
  it('works out arithmetic', () => {
    expect(evalArithmetic('100*10')).toBe(1000);
    expect(evalArithmetic('(120+30)*4')).toBe(600);
    expect(evalArithmetic('=£1,000/4')).toBe(250);
  });
  it('refuses what is not a sum', () => {
    expect(evalArithmetic('10/0')).toBeNull();
    expect(evalArithmetic('alert(1)')).toBeNull();
  });
});

describe('buildLinesPayload — what gets stored', () => {
  it('keeps a qty/rate split only when it multiplies out', () => {
    const good = { ...typed(['qty', '12'], ['rate', '50']), service: 'Payroll', description: ' x ' };
    const stale = { ...typed(['net', '100']), service: 'Admin', qty: '3', rate: '7' };
    const { lines, totals, summary } = buildLinesPayload([good, stale]);
    expect(lines[0]).toMatchObject({ service: 'Payroll', description: 'x', qty: 12, rate: 50, net: 600, vat: 120, gross: 720 });
    expect(lines[1]).toMatchObject({ qty: 1, rate: 100, net: 100 });
    expect(totals).toEqual({ net: 700, vat: 140, gross: 840 });
    expect(summary).toBe('Payroll +1 more');
  });
  it('drops lines without a service or an amount', () => {
    const priced = { ...typed(['net', '50']), service: 'Admin' };
    const { lines } = buildLinesPayload([blankLine(), { ...blankLine(), service: 'Admin' }, priced]);
    expect(lines).toHaveLength(1);
  });
  it('with no complete line at all it throws — callers only build once one exists (canSubmit)', () => {
    expect(() => buildLinesPayload([blankLine()])).toThrow();
  });
  it('a hand-typed VAT figure is kept', () => {
    const l = { ...typed(['net', '100']), service: 'Admin', vat: '0', vatManual: true };
    expect(buildLinesPayload([l]).lines[0]).toMatchObject({ vat: 0, gross: 100 });
  });
});

describe('copying a past invoice', () => {
  it('brings the qty/rate split across', () => {
    const [l] = invoiceToLines({ lines: [{ service: 'Bookkeeping', description: 'Monthly', amount: 600, qty: 12, unit_price: 50 }] });
    expect(l).toMatchObject({ service: 'Bookkeeping', qty: '12', rate: '50', net: '600', vat: '120.00', gross: '720.00' });
  });
  it('an empty invoice gives one blank line', () => {
    expect(invoiceToLines({ lines: [] })).toEqual([blankLine()]);
  });
});

describe('number helpers', () => {
  it('fmtNum trims trailing zeros', () => {
    expect(fmtNum(10, 4)).toBe('10');
    expect(fmtNum(33.333333, 4)).toBe('33.3333');
  });
  it('splitOf falls back to 1 × the amount', () => {
    expect(splitOf(null, null, 250)).toEqual({ qty: '1', rate: '250' });
    expect(splitOf(4, 25, 100)).toEqual({ qty: '4', rate: '25' });
  });
});
