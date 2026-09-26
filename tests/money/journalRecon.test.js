import { describe, it, expect } from 'vitest';
import { lineSummary, probeEntry, reconcile, nameMatches, norm } from '../../supabase/functions/_shared/journal-recon.ts';

// A QuickBooks JournalEntry as BrightPay posts it: TotalAmt always 0, the
// figure only in the lines, and "Sent from BrightPay" in PrivateNote.
let nextId = 1;
const je = ({ date, debit, credit = debit, note = 'Sent from BrightPay', account = 'Wages & Salaries' }) => probeEntry({
  Id: String(nextId++), TxnDate: date, TotalAmt: 0, PrivateNote: note,
  MetaData: { CreateTime: `${date}T12:00:00Z` },
  Line: [
    { Amount: debit, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: account } } },
    { Amount: credit, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { name: 'PAYE/NI' } } },
  ],
});
const task = (over) => ({ id: 't1', period_start: '2026-07-01', period_end: '2026-07-31', amount: null, evidence: 'posted', ...over });
const kinds = (fs) => fs.map((f) => f.kind).sort();

describe('lineSummary / probeEntry', () => {
  it('sums the debit lines, because TotalAmt is zero on every journal', () => {
    const s = lineSummary({ TotalAmt: 0, Line: [
      { Amount: 100.1, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'Wages' } } },
      { Amount: 0.2, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'Wages' } } },
      { Amount: 100.3, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { name: 'PAYE' } } },
    ] });
    expect(s).toEqual({ line_count: 3, debit_total: 100.3, credit_total: 100.3, accounts: ['Wages', 'PAYE'] });
  });

  it('tells BrightPay journals from a client\'s own', () => {
    expect(je({ date: '2026-07-31', debit: 1 }).source).toBe('brightpay');
    expect(je({ date: '2026-07-31', debit: 1, note: 'Accrual' }).source).toBe('other');
  });
});

describe('reconcile — agreement', () => {
  it('payroll + Employment Allowance post separately and match the task as a sum (MAC Recruit, July)', () => {
    const js = [je({ date: '2026-07-31', debit: 31845.98 }), je({ date: '2026-07-31', debit: 3331.24 })];
    expect(reconcile([task({ amount: 35177.22 })], js)).toEqual([]);
  });

  it('weekly payrolls inside one monthly task match as a sum, not as duplicates', () => {
    const js = ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31'].map((date) => je({ date, debit: 1200 }));
    expect(reconcile([task({ amount: 6000 })], js)).toEqual([]);
  });

  it('a catch-up task spanning several months takes every journal in its range', () => {
    const js = [je({ date: '2026-04-30', debit: 500 }), je({ date: '2026-05-29', debit: 500 }), je({ date: '2026-06-30', debit: 500 })];
    expect(reconcile([task({ period_start: '2026-04-01', period_end: '2026-06-30', amount: 1500 })], js)).toEqual([]);
  });

  it('tolerates up to 2p of rounding, not 3p', () => {
    expect(reconcile([task({ amount: 1000.02 })], [je({ date: '2026-07-31', debit: 1000 })])).toEqual([]);
    expect(kinds(reconcile([task({ amount: 1000.03 })], [je({ date: '2026-07-31', debit: 1000 })]))).toEqual(['amount_mismatch']);
  });

  it('ignores a client\'s own manual journals entirely', () => {
    const js = [je({ date: '2026-07-31', debit: 900 }), je({ date: '2026-07-31', debit: 900, note: 'manual' })];
    expect(reconcile([task({ amount: 900 })], js)).toEqual([]);
  });
});

describe('reconcile — findings', () => {
  it('duplicate: two BrightPay journals with the same date and total (LJM Gas, posted twice 83 minutes apart)', () => {
    const js = [je({ date: '2026-07-31', debit: 4210.55 }), je({ date: '2026-07-31', debit: 4210.55 })];
    const fs = reconcile([task({ amount: 4210.55 })], js);
    const dup = fs.find((f) => f.kind === 'duplicate');
    expect(dup).toMatchObject({ severity: 'high', period: '2026-07' });
    expect(dup.data.journals).toHaveLength(2);
    // and the doubled total no longer agrees with the task
    expect(kinds(fs)).toEqual(['amount_mismatch', 'duplicate']);
  });

  it('a duplicate is found even with no task at all', () => {
    const js = [je({ date: '2026-07-31', debit: 50 }), je({ date: '2026-07-31', debit: 50 })];
    expect(kinds(reconcile([], js))).toEqual(['duplicate', 'orphan', 'orphan']);
  });

  it('zero-value journals are never called duplicates', () => {
    const js = [je({ date: '2026-07-31', debit: 0 }), je({ date: '2026-07-31', debit: 0 })];
    expect(kinds(reconcile([task({ amount: 0 })], js))).toEqual([]);
  });

  it('missing: the task says posted but no BrightPay journal is in its period', () => {
    const fs = reconcile([task({ amount: 800 })], [je({ date: '2026-06-30', debit: 800 })]);
    expect(kinds(fs)).toEqual(['missing', 'orphan']);
    expect(fs.find((f) => f.kind === 'missing')).toMatchObject({ severity: 'high', task_id: 't1', data: { expected: 800 } });
  });

  it('no expected figure: imported history is low-severity legacy, a system posting is unverifiable', () => {
    const js = [je({ date: '2026-07-31', debit: 800 })];
    expect(reconcile([task({ evidence: 'imported from JnlLog' })], js)[0]).toMatchObject({ kind: 'legacy_no_expected_figure', severity: 'low' });
    expect(reconcile([task({ evidence: 'posted' })], js)[0]).toMatchObject({ kind: 'unverifiable_amount', severity: 'low' });
  });

  it('unbalanced: debits and credits more than 2p apart', () => {
    expect(kinds(reconcile([task({ amount: 500 })], [je({ date: '2026-07-31', debit: 500, credit: 499 })]))).toEqual(['unbalanced']);
  });

  it('uncategorised account: a payroll journal posting to Uncategorised needs its mapping fixed', () => {
    const fs = reconcile([task({ amount: 500 })], [je({ date: '2026-07-31', debit: 500, account: 'Uncategorised Expense' })]);
    expect(fs[0]).toMatchObject({ kind: 'uncategorised_account', severity: 'medium' });
  });
});

describe('employer name matching', () => {
  it('Ltd and Limited are the same company, stripped from both sides', () => {
    expect(nameMatches(norm('Amy Plumbing Ltd'), norm('Amy Plumbing Limited'))).toBe(true);
    expect(nameMatches(norm('Amy Plumbing Limited'), norm('Amy Plumbing'))).toBe(true);
    expect(nameMatches(norm('Ready Rentals LLP'), norm('Ready Rentals'))).toBe(true);
  });

  it('different companies, or a blank name, never match', () => {
    expect(nameMatches(norm('Amy Plumbing Ltd'), norm('Amy Heating Ltd'))).toBe(false);
    expect(nameMatches(norm('Ltd'), norm('Limited'))).toBe(false);
    expect(nameMatches('', '')).toBe(false);
  });
});
