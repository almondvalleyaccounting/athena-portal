// The service vocabularies that can end up on a QuickBooks invoice, in one
// place. Both the ad-hoc bill editor (/billing) and the product mapping page
// (/manage/billing/products) read from here, so a label can never exist in
// the editor without also appearing on the mapping screen.
//
// Nothing here decides where revenue codes — qbo_service_items does. These
// are only the candidate service ids the mapping page must offer a row for.

// Ad-hoc bill line labels. Historically a hardcoded array inside
// BillingPage; the editor now only offers the ones that are actually mapped,
// so this is the list of labels staff *could* have, not the ones they get.
// Three labels are deliberately absent. 'Admin' was retired in sql/178 — it
// coded to a catch-all account and, as a label, hid what the work actually
// was. 'Advisory' and 'Company Secretarial' followed in sql/179: both are
// category names in the rebuilt QBO hierarchy, and billing against a category
// is precisely what put revenue on a catch-all to begin with. Pick the leaf.
export const ADHOC_SERVICES = [
  'Accounts Production',
  'Corporation Tax',
  'Self Assessment',
  'VAT Returns',
  'Bookkeeping',
  'Payroll',
  'Management Accounts',
  'Registered Office',
  'Software',
  'SA302s',
  'Accountant Certificates',
];

// Fee-engine service ids (quotes -> live billing). Labels mirror
// SERVICE_LABELS in src/lib/billingComparison.js.
export const FEE_ENGINE_SERVICES = [
  { id: 'accounts_ct', label: 'Accounts & CT' },
  { id: 'sole_trader_accounts', label: 'Sole Trader Accounts' },
  { id: 'mtd_returns', label: 'MTD Returns' },
  { id: 'confirmation_statement', label: 'Confirmation Statement' },
  { id: 'directors_tax_return', label: "Directors' Tax Returns" },
  { id: 'bookkeeping_vat', label: 'Bookkeeping & VAT' },
  { id: 'vat_returns', label: 'VAT Returns' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'auto_enrolment', label: 'Auto-Enrolment' },
  { id: 'modulr', label: 'Modulr' },
  { id: 'management_accounts', label: 'Management Accounts' },
  { id: 'review_meetings', label: 'Review Meetings' },
  { id: 'budgeting', label: 'Budgeting & Forecasting' },
  { id: 'fractional_cfo', label: 'Fractional CFO' },
  { id: 'registered_office', label: 'Registered Office' },
  { id: 'software', label: 'Software' },
  { id: 'software_accounting', label: 'Software (accounting)' },
  { id: 'setup_formation', label: 'Company Formation' },
  { id: 'setup_hmrc', label: 'HMRC Registrations' },
];

// Every service id the mapping page should show a row for: the fee-engine
// ids, the ad-hoc labels, then anything already mapped that predates either
// list. `kind` drives the grouping on that page.
export function candidateServices(existingRows = []) {
  const seen = new Set();
  const out = [];
  for (const s of FEE_ENGINE_SERVICES) {
    seen.add(s.id);
    out.push({ id: s.id, label: s.label, kind: 'fee_engine' });
  }
  for (const label of ADHOC_SERVICES) {
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ id: label, label, kind: 'adhoc' });
  }
  for (const r of existingRows) {
    if (!r.service_id || seen.has(r.service_id)) continue;
    seen.add(r.service_id);
    out.push({ id: r.service_id, label: r.label || r.service_id, kind: r.is_adhoc ? 'adhoc' : 'fee_engine' });
  }
  return out;
}
