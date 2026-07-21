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

// itemName(lower) → athena service id. Two QBO items map from two services
// (Payroll, Bookkeeping & VAT) — prefer the primary.
function buildReverseMap(maps) {
  const PRIMARY = { payroll: 1, bookkeeping_vat: 1 };
  const byName = {};
  for (const m of maps || []) {
    const key = (m.qbo_item_name || '').toLowerCase().trim();
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
    const id = rev[raw.toLowerCase().trim()] || normalizeId(raw);
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
