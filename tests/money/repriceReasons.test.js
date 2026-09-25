import { describe, it, expect } from 'vitest';
import {
  componentsOf, summarise, summaryRows, suggestReason, firstOfNextMonth, lineNeedsAcceptance,
} from '../../src/modules/billing/repriceReasons.js';

const sum = (xs) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;

describe('componentsOf', () => {
  it('a plain rise is one change in our fees', () => {
    const c = componentsOf({ current: 100, next: 106, reasonKey: 'inflation' });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ bucket: 'ourFees', amount: 6, needsAcceptance: false });
  });

  it('the first reason takes whatever the extras leave, so the line always balances', () => {
    // The header's example: Accounts split out −£80, then our fee raised +£6.
    const line = { current: 200, next: 126, reasonKey: 'inflation', extra: [{ reasonKey: 'split', amount: -80 }] };
    const c = componentsOf(line);
    expect(c.find((x) => x.primary)).toMatchObject({ bucket: 'ourFees', amount: 6 });
    expect(c.find((x) => !x.primary)).toMatchObject({ bucket: 'split', amount: -80 });
    expect(sum(c.map((x) => x.amount))).toBe(line.next - line.current);
  });

  it('an our-fee reason follows the direction the money moved', () => {
    expect(componentsOf({ current: 100, next: 90, reasonKey: 'inflation' })[0].bucket).toBe('reductions');
    expect(componentsOf({ current: 100, next: 110, reasonKey: 'goodwill' })[0].bucket).toBe('ourFees');
  });

  it('a line from £0 is a new service and needs acceptance; a line to £0 is a removal', () => {
    const add = { current: 0, next: 50, reasonKey: 'inflation' };
    expect(componentsOf(add)[0].bucket).toBe('newService');
    expect(lineNeedsAcceptance(add)).toBe(true);
    const drop = { current: 50, next: 0, reasonKey: 'inflation' };
    expect(componentsOf(drop)[0].bucket).toBe('removed');
    expect(lineNeedsAcceptance(drop)).toBe(false);
  });

  it('only a new service needs acceptance', () => {
    for (const reasonKey of ['inflation', 'goodwill', 'ch_fee', 'software', 'split', 'other']) {
      expect(lineNeedsAcceptance({ current: 100, next: 120, reasonKey })).toBe(false);
    }
  });

  it('drops changes that net to zero', () => {
    expect(componentsOf({ current: 100, next: 100, reasonKey: 'inflation' })).toEqual([]);
  });
});

describe('summarise', () => {
  const lines = [
    { current: 62.5, next: 66.25, reasonKey: 'inflation' },
    { current: 150, next: 183.59, reasonKey: 'employees' },
    { current: 0, next: 15, reasonKey: 'new_service' },
    { current: 9.17, next: 0, reasonKey: 'removed' },
    { current: 33.33, next: 33.33, reasonKey: 'inflation' },
  ];
  const s = summarise(lines);

  it('current + every bucket = next, to the penny', () => {
    expect(sum([s.current, ...Object.values(s.buckets)])).toBe(s.next);
    expect(s.delta).toBe(sum([s.next, -s.current]));
  });

  it('VAT is 20% of the new net fee, gross is net + VAT', () => {
    expect(s.next).toBe(298.17);
    expect(s.vat).toBe(59.63);
    expect(s.gross).toBe(357.8);
  });

  it('flags a proposal when any line adds a service', () => {
    expect(s.needsAcceptance).toBe(true);
    expect(summarise(lines.filter((l) => l.current > 0)).needsAcceptance).toBe(false);
  });

  it('proposal rows: part 1 subtotal = current + part-1 changes; ends on VAT then total', () => {
    const rows = summaryRows(s);
    const sub = rows.find((r) => r.type === 'subtotal');
    expect(sub.v).toBe(sum([s.next, -s.buckets.newService]));
    expect(rows.at(-2)).toMatchObject({ type: 'vat', v: s.vat });
    expect(rows.at(-1)).toMatchObject({ type: 'grand', v: s.gross });
  });
});

describe('suggestReason', () => {
  it('a payroll rise with headcount unchanged is inflation, however big (Accona)', () => {
    expect(suggestReason({ serviceId: 'payroll', current: 100, next: 111, growth: { employees: 'same' } })).toBe('inflation');
  });

  it('a payroll rise with headcount up is more employees', () => {
    expect(suggestReason({ serviceId: 'payroll', current: 100, next: 103, growth: { employees: 'up' } })).toBe('employees');
  });

  it('without drivers, a rise over 10% reads as growth', () => {
    expect(suggestReason({ serviceId: 'accounts_ct', current: 100, next: 115 })).toBe('turnover');
    expect(suggestReason({ serviceId: 'accounts_ct', current: 100, next: 105 })).toBe('inflation');
  });
});

describe('firstOfNextMonth', () => {
  it('rolls over the year end', () => {
    expect(firstOfNextMonth(new Date(2026, 11, 15))).toBe('2027-01-01');
  });

  it('handles the 31st without skipping February', () => {
    expect(firstOfNextMonth(new Date(2026, 0, 31))).toBe('2026-02-01');
  });
});
