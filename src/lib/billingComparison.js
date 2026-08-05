// Compare a quote (its recurring line items) against current live billing.
// The quote stores Athena service ids (accounts_ct…); live_billing.services
// stores QBO item NAMES, so we reverse-map live services through
// qbo_service_items to line them up. Pure — no I/O.

const SERVICE_LABELS = {
  accounts_ct: 'Accounts & CT',
  sole_trader_accounts: 'Sole Trader Accounts',
  mtd_returns: 'MTD Returns',
  confirmation_statement: 'Confirmation Statement',
  directors_tax_return: "Directors' Tax Returns",
  bookkeeping_vat: 'Bookkeeping & VAT',
  vat_returns: 'VAT Returns',
  payroll: 'Payroll',
  auto_enrolment: 'Auto-Enrolment',
  modulr: 'Modulr',
  management_accounts: 'Management Accounts',
  review_meetings: 'Review Meetings',
  budgeting: 'Budgeting & Forecasting',
  fractional_cfo: 'Fractional CFO',
  registered_office: 'Registered Office',
  software: 'Software',
};

// Collapse near-duplicate ids so quote and live align.
function normalizeId(id) {
  const s = String(id || '').toLowerCase().trim();
  if (s.startsWith('software')) return 'software';
  if (s === 'bookkeeping') return 'bookkeeping_vat';
  return s;
}

// The QBO catalogue is a hierarchy, so a pull stores the fully-qualified name
// — "Accounts:Accounts & Corporation Tax" — while qbo_service_items holds the
// bare item name. Match on the leaf so both forms line up, and so live_billing
// rows captured before and after the products were nested still agree.
//
// The deeper fragility: live_billing.services identifies a service by NAME,
// not by QBO item id, so renaming a product orphans every row captured before
// the rename. The 2026-08-04 catalogue rebuild renamed 14 items, so their
// former names are mapped here. Matching on item id would remove the need for
// this list entirely — worth doing next time the pull is touched.
const RENAMED = {
  'annual statutory accounts & business tax': 'accounts & corporation tax',
  'sole trader accounts': 'statutory accounts - sole trader',
  'dormant company accounts': 'statutory accounts - dormant ltd company',
  'self assessment tax return': 'tax returns - individual',
  'mtd return': 'tax returns - mtd',
  'bookkeeping & vat returns': 'bookkeeping (vat registered)',
  'finance director services': 'fractional cfo',
  'annual review meeting': 'review meetings',
  'annual confirmation statement': 'confirmation statement',
  'registrations/amendments': 'hmrc registrations',
  'software licences': 'software',
  'all inclusive accountancy & tax services package (vat registered)':
    'all inclusive fees - ltd companies (vat registered)',
  'all inclusive accountancy & tax services package (not vat registered)':
    'all inclusive fees - ltd companies (not vat registered)',
  'all inclusive accountancy & tax services package - self employed, no vat':
    'all inclusive fees - sole traders',
};

function leafName(v) {
  const leaf = String(v || '').split(':').pop().toLowerCase().trim();
  return RENAMED[leaf] || leaf;
}

// itemName(lower) → athena service id. Two QBO items map from two services
// (Payroll, Bookkeeping & VAT) — prefer the primary.
function buildReverseMap(maps) {
  const PRIMARY = { payroll: 1, bookkeeping_vat: 1 };
  const byName = {};
  for (const m of maps || []) {
    const key = leafName(m.qbo_item_name);
    if (!key) continue;
    (byName[key] = byName[key] || []).push(m.service_id);
  }
  const resolved = {};
  for (const [name, ids] of Object.entries(byName)) {
    resolved[name] = ids.slice().sort((a, b) => (PRIMARY[b] || 0) - (PRIMARY[a] || 0))[0];
  }
  return resolved;
}

const annualOf = (s) => Number(s.annual_amount) || (Number(s.monthly_amount) || 0) * 12;

// quoteLines: [{ service_id, description, annual_amount, monthly_amount, is_recurring }]
// liveServices: live_billing.services [{ service_id (QBO item name), description, annual_amount, monthly_amount, cadence }]
// maps: qbo_service_items rows [{ service_id, qbo_item_name }]
export function compareQuoteToBilling(quoteLines, liveServices, maps) {
  const rev = buildReverseMap(maps);

  const quoteById = {};
  const labelById = {};
  for (const l of quoteLines || []) {
    if (l.is_recurring === false) continue; // recurring only
    const id = normalizeId(l.service_id);
    if (!id) continue;
    quoteById[id] = (quoteById[id] || 0) + annualOf(l);
    if (!labelById[id]) labelById[id] = SERVICE_LABELS[id] || l.description || l.service_id;
  }

  const liveById = {};
  for (const s of liveServices || []) {
    const raw = String(s.service_id || '');
    // live_billing.service_id is either a QBO item name (bare or fully
    // qualified) or, on older rows, an Athena slug — try the reverse map on
    // the leaf first, then fall back to treating it as a slug.
    const id = rev[leafName(raw)] || normalizeId(raw);
    if (!id) continue;
    liveById[id] = (liveById[id] || 0) + annualOf(s);
    if (!labelById[id]) labelById[id] = SERVICE_LABELS[id] || s.description || raw;
  }

  const ids = [...new Set([...Object.keys(quoteById), ...Object.keys(liveById)])];
  const rows = ids.map((id) => {
    const quoteAnnual = Math.round((quoteById[id] || 0) * 100) / 100;
    const liveAnnual = Math.round((liveById[id] || 0) * 100) / 100;
    const deltaAnnual = Math.round((quoteAnnual - liveAnnual) * 100) / 100;
    let status = 'same';
    if (liveAnnual === 0 && quoteAnnual > 0) status = 'new';
    else if (quoteAnnual === 0 && liveAnnual > 0) status = 'removed';
    else if (Math.abs(deltaAnnual) > 0.5) status = 'changed';
    return {
      id,
      label: SERVICE_LABELS[id] || labelById[id] || id,
      quoteAnnual, liveAnnual, deltaAnnual, status,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  const quoteAnnual = Math.round(rows.reduce((s, r) => s + r.quoteAnnual, 0) * 100) / 100;
  const liveAnnual = Math.round(rows.reduce((s, r) => s + r.liveAnnual, 0) * 100) / 100;
  const deltaAnnual = Math.round((quoteAnnual - liveAnnual) * 100) / 100;
  const pct = liveAnnual > 0 ? Math.round((deltaAnnual / liveAnnual) * 1000) / 10 : null;

  return {
    rows,
    totals: {
      quoteAnnual, liveAnnual, deltaAnnual,
      quoteMonthly: Math.round((quoteAnnual / 12) * 100) / 100,
      liveMonthly: Math.round((liveAnnual / 12) * 100) / 100,
      deltaMonthly: Math.round((deltaAnnual / 12) * 100) / 100,
      pct,
    },
    hasLive: Object.keys(liveById).length > 0,
  };
}
