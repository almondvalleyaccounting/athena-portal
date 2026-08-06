// The service vocabularies that can end up on a QuickBooks invoice, in one
// place. Both the ad-hoc bill editor (/billing) and the product mapping page
// (/manage/billing/products) read from here.
//
// qbo_service_items in the database is the authority — the bill dropdown is
// built from it, and nothing here decides where revenue codes. These arrays
// only seed the mapping page's candidate rows, so a service whose mapping gets
// deleted can still be found and re-mapped. They mirror the QBO catalogue as
// rebuilt on 2026-08-04; anything absent from both the arrays and the table
// simply isn't billable.

// The QuickBooks grouping items, in the order the service picker shows them.
// Categories come from the database (qbo_service_items.qbo_category, sql/189);
// this only fixes their order, which is by how often a one-off bill lands in
// each rather than alphabetical — Accounts and Tax Returns are most of the
// work, All Inclusive is recurring bundles that never appear on an ad-hoc bill.
// A category in QBO but missing here still shows, sorted in after these.
export const QBO_CATEGORY_ORDER = [
  'Accounts',
  'Tax Returns',
  'Bookkeeping',
  'Payroll Related',
  'Advisory',
  'Company Secretarial',
  'All Inclusive',
  'Other',
];

// Ad-hoc bill line labels. One per billable QBO leaf, so a one-off bill can
// always be coded to what the work actually was.
//
// Deliberately absent: 'Admin' (sql/178), 'Advisory' and 'Company Secretarial'
// (sql/179). The first coded to a catch-all income account; the other two are
// category names in the rebuilt hierarchy, and billing against a category is
// what put revenue on a catch-all to begin with. Also absent are the All
// Inclusive packages and the Retainer — recurring bundles, not one-off work.
export const ADHOC_SERVICES = [
  'Accountant Certificates',
  'Bespoke Analysis',
  'Billable Hours',
  'Bookkeeping',
  'Bookkeeping (non-VAT registered)',
  // Renamed from 'Statutory Accounts …' and 'Accounts Production' on
  // 2026-08-06 (sql/186) — the QBO products were renamed to match, so the term
  // the client reads on an invoice is the term the team picks here. 'Business
  // Accounts - Ltd Companies' IS the old 'Accounts Production': same QBO item
  // (#59), not a new product.
  'Business Accounts - Dormant Ltd Company',
  'Business Accounts - LLP',
  'Business Accounts - Ltd Companies',
  'Business Accounts - Partnership',
  'Business Accounts - Property',
  'Business Accounts - Sole Trader',
  'Business Accounts and Corporation Tax Combined',
  'Business Plans',
  'Companies House Amendments',
  'Company Formation',
  'Confirmation Statement',
  'Corporation Tax',
  'Fee Protection Insurance',
  'Fractional CFO',
  'HMRC Registrations',
  'ID Verification',
  'Management Accounts',
  'Payroll',
  'Registered Office',
  'Review Meetings',
  'SA302s',
  'Self Assessment',
  'Software',
  'Tax Returns - LLP',
  'Tax Returns - MTD',
  'Tax Returns - Partnership (SA800)',
  'VAT Returns',
];

// Fee-engine service ids (quotes -> live billing). These are the canonical
// side of the quote-vs-live reverse map: one per QBO item.
export const FEE_ENGINE_SERVICES = [
  // accounts and tax
  // Ids are slugs and never change — quotes, standard fees, entity fees and
  // live billing all key off them. Only the labels moved to "Business
  // Accounts" (sql/186).
  { id: 'accounts_ct', label: 'Business Accounts & CT' },
  { id: 'ltd_accounts', label: 'Business Accounts — Ltd' },
  { id: 'llp_accounts', label: 'Business Accounts — LLP' },
  { id: 'partnership_accounts', label: 'Business Accounts — Partnership' },
  { id: 'property_accounts', label: 'Business Accounts — Property' },
  { id: 'sole_trader_accounts', label: 'Sole Trader Accounts' },
  { id: 'dormant_accounts', label: 'Dormant Accounts' },
  { id: 'ct600', label: 'CT600' },
  { id: 'llp_tax_return', label: 'Tax Returns — LLP' },
  { id: 'partnership_tax_return', label: 'Tax Returns — Partnership' },
  { id: 'directors_tax_return', label: "Directors' Tax Returns" },
  { id: 'mtd_returns', label: 'MTD Returns' },
  // bookkeeping and payroll
  { id: 'bookkeeping_vat', label: 'Bookkeeping & VAT' },
  { id: 'bookkeeping_novat', label: 'Bookkeeping (non-VAT)' },
  { id: 'vat_returns', label: 'VAT Returns' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'auto_enrolment', label: 'Auto-Enrolment' },
  { id: 'modulr', label: 'Modulr' },
  // advisory
  { id: 'management_accounts', label: 'Management Accounts' },
  { id: 'review_meetings', label: 'Review Meetings' },
  { id: 'fractional_cfo', label: 'Fractional CFO' },
  { id: 'bespoke_analysis', label: 'Bespoke Analysis' },
  { id: 'business_plans', label: 'Business Plans' },
  { id: 'billable_hours', label: 'Billable Hours' },
  { id: 'budgeting', label: 'Budgeting & Forecasting' },
  // company secretarial
  { id: 'confirmation_statement', label: 'Confirmation Statement' },
  { id: 'setup_formation', label: 'Company Formation' },
  { id: 'setup_hmrc', label: 'HMRC Registrations' },
  { id: 'companies_house_amendments', label: 'Companies House Amendments' },
  { id: 'id_verification', label: 'ID Verification' },
  { id: 'registered_office', label: 'Registered Office' },
  // all inclusive bundles
  { id: 'all_inclusive_ltd_vat', label: 'All Inclusive — Ltd (VAT reg)' },
  { id: 'all_inclusive_ltd_novat', label: 'All Inclusive — Ltd (not VAT reg)' },
  { id: 'all_inclusive_sole_trader', label: 'All Inclusive — Sole Trader' },
  { id: 'all_inclusive_llp', label: 'All Inclusive — LLP' },
  { id: 'all_inclusive_partnership', label: 'All Inclusive — Partnership' },
  { id: 'retainer', label: 'Accountancy Services Retainer' },
  // other
  { id: 'software', label: 'Software' },
  { id: 'software_accounting', label: 'Software (accounting)' },
  { id: 'fee_protection', label: 'Fee Protection Insurance' },
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
