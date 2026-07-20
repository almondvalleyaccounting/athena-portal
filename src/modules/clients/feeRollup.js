// Approved-fee roll-up from live_billing rows — the ONE implementation,
// shared by the client list and the client detail page (previously duplicated
// in both, which meant every rule change had to be made twice).
//
// Rules:
//  * only rows with status 'active' (legacy rows with no status count too)
//  * skip service lines with recurring_status 'ending'
//  * effective approval = approval_status, defaulting to 'approved' when the
//    row is template-linked (qbo_recurring_txn_id) and 'suggested' otherwise
//  * monthly_amount is the per-cycle charge for BOTH cadences — the stored
//    annual_amount is monthly_amount × 12 and would inflate totals.

export function approvedServicesOf(rows) {
  const out = [];
  for (const b of rows || []) {
    if (b.status && b.status !== 'active') continue;
    const services = Array.isArray(b.services) ? b.services : [];
    for (const s of services) {
      if (s.recurring_status === 'ending') continue;
      const status = s.approval_status || (b.qbo_recurring_txn_id ? 'approved' : 'suggested');
      if (status !== 'approved') continue;
      out.push({ ...s, row_id: b.id, fromTemplate: !!b.qbo_recurring_txn_id });
    }
  }
  return out;
}

// Standard minimum annual fee for flat-rate services with a clear minimum
// (mirrors quote_defaults). Variable/turnover-banded services (accounts,
// payroll, bookkeeping…) have no single minimum, so they're not flagged.
// Matched loosely against both naming regimes in live_billing.services
// (Athena slugs + QBO-pulled labels). Ported from the retired fee-engine
// client page.
const STANDARD_MIN_ANNUAL = [
  { test: /confirmation/i, min: 110, label: 'Confirmation statement' },
  { test: /registered.?office/i, min: 180, label: 'Registered office' },
  { test: /review.?meeting/i, min: 210, label: 'Annual review meeting' },
  { test: /dormant/i, min: 150, label: 'Dormant accounts' },
  { test: /auto.?enrol/i, min: 60, label: 'Auto enrolment' },
];

// Under-billing check for one approved service line: returns
// { min, under } when the line's annualised fee sits below a known standard
// minimum, else null. Annualised = monthly_amount ×12 for monthly cadence;
// for annual cadence monthly_amount IS the yearly fee.
export function underBillingOf(service) {
  const hay = `${service.service_id || ''} ${service.description || ''}`;
  const rule = STANDARD_MIN_ANNUAL.find((r) => r.test.test(hay));
  if (!rule) return null;
  const amount = Number(service.monthly_amount) || 0;
  const annualised = service.cadence === 'annual' ? amount : amount * 12;
  if (annualised <= 0 || annualised >= rule.min) return null;
  return { min: rule.min, under: Math.round((rule.min - annualised) * 100) / 100 };
}

// { monthly, annual, hasTemplate } for one entity's live_billing rows.
export function feeTotals(rows) {
  const services = approvedServicesOf(rows);
  const round = (n) => Math.round(n * 100) / 100;
  const sum = (cadence) => services
    .filter((s) => s.cadence === cadence)
    .reduce((acc, s) => acc + (Number(s.monthly_amount) || 0), 0);
  return {
    monthly: round(sum('monthly')),
    annual: round(sum('annual')),
    hasTemplate: (rows || []).some((b) => (!b.status || b.status === 'active') && b.qbo_recurring_txn_id),
  };
}
