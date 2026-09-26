import { describe, it, expect } from 'vitest';
import { reasonParagraph } from '../../src/modules/billing/composeRepriceEmail.js';

// The "why" paragraph of a fee review email is written from the reasons on
// the lines, so it can only say what is true for that client.
describe('reasonParagraph', () => {
  it('inflation, a business change and a cost passed on', () => {
    const lines = [
      { serviceId: 'Accounts:Accounts', current: 82, next: 87, reasonKey: 'inflation' },
      { serviceId: 'Payroll Related:Payroll', current: 15, next: 19, reasonKey: 'employees' },
      { serviceId: 'Company Secretarial:Confirmation Statement', current: 3, next: 10, reasonKey: 'ch_fee', extra: [{ reasonKey: 'inflation', amount: 1 }] },
    ];
    expect(reasonParagraph(lines, { lastReviewed: 'March 2024' })).toBe(
      'We have reviewed our fees. The changes are due to inflation, and because your business has changed since we last reviewed them in March 2024: you now have more employees on the payroll. Companies House has also increased its fees, which we pass on at cost.',
    );
  });

  it('several business changes and work now billed, without a review date', () => {
    const lines = [
      { serviceId: 'Accounts:Accounts', current: 80, next: 95, reasonKey: 'turnover' },
      { serviceId: 'VAT:VAT Returns', current: 0, next: 30, reasonKey: 'vat_registered', extra: [] },
      { serviceId: 'Company Secretarial:Registered Office', current: 0, next: 10, reasonKey: 'already_provided' },
    ];
    expect(reasonParagraph(lines)).toBe(
      'We have reviewed our fees. The changes are because your business has changed since we last reviewed them: your turnover has increased and you are now VAT registered. We are also now billing monthly for work we already do for you: Registered Office.',
    );
  });

  it('inflation alone', () => {
    expect(reasonParagraph([{ serviceId: 'Payroll', current: 15, next: 16, reasonKey: 'inflation' }]))
      .toBe('We have reviewed our fees. The changes are due to inflation.');
  });
});
