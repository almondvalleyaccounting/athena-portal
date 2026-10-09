/*
  Open sales-ledger items — the arithmetic behind the Overdue invoices tab and
  the customer statements. PURE: shared with the client portal through @dash,
  so it imports nothing.

  Input is the `open_items` metric (dashboard-qbo-pull → openItemsAsAt): every
  item QuickBooks' AgedReceivableDetail report says was open on the as-at date
  — invoices, and also credit notes, unapplied payments and journals, which
  carry a NEGATIVE open balance.

  Two different questions are asked of it, deliberately answered differently:

    • The TAB lists overdue INVOICES: open, positive, due before the as-at date.
      A credit note is not overdue, and a payment sitting unapplied is not a
      debt, so neither belongs in a chase list.
    • A STATEMENT lists everything open for the customer, credits included,
      because a statement that ignored a credit would ask for money the
      customer does not owe. Its total is the net balance; its "overdue" figure
      is the overdue invoices, capped at that balance.
*/

const DAY = 86400000;
const toDay = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export function daysBetween(fromIso, toIso) {
  const a = toDay(fromIso);
  const b = toDay(toIso);
  return a == null || b == null ? null : Math.round((b - a) / DAY);
}

// Money to the penny — an invoice list rounded to the pound does not add up.
export function money2(v, currency = 'GBP') {
  if (v === null || v === undefined || isNaN(v)) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: currency || 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `£${Number(v).toFixed(2)}`;
  }
}

export function dateGB(iso) {
  const t = toDay(iso);
  if (t == null) return '';
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const AGE_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd91', label: 'Over 90 days' },
];

export function ageBucket(daysOverdue) {
  if (daysOverdue == null || daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd91';
}

const isInvoice = (i) => /^invoice$/i.test(i?.type || '');

// Every open item with its age as at the statement date.
export function withAge(items, asAt) {
  return (items || []).map((i) => {
    const days = i.due_date ? daysBetween(i.due_date, asAt) : null;
    // A credit is aged (QuickBooks ages it, and the buckets must add up to the
    // balance) but it is never "overdue" — nobody owes it.
    const late = i.open > 0 && days != null && days > 0 ? days : 0;
    return { ...i, days_overdue: late, bucket: ageBucket(days) };
  });
}

// The tab's list: overdue invoices only.
export function overdueInvoices(data) {
  if (!data?.items) return [];
  return withAge(data.items, data.as_at)
    .filter((i) => isInvoice(i) && i.open > 0.004 && i.days_overdue > 0);
}

// Oldest first — the order a credit controller works in.
export function sortByDue(rows) {
  return [...rows].sort((a, b) =>
    String(a.due_date || '').localeCompare(String(b.due_date || ''))
    || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

// Group rows by customer, biggest overdue balance first.
export function groupByCustomer(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.customer_id || r.customer;
    if (!map.has(key)) map.set(key, { key, customer_id: r.customer_id, customer: r.customer, rows: [], total: 0, oldest: 0 });
    const g = map.get(key);
    g.rows.push(r);
    g.total += r.open;
    g.oldest = Math.max(g.oldest, r.days_overdue);
  }
  const out = [...map.values()].map((g) => ({ ...g, rows: sortByDue(g.rows) }));
  out.sort((a, b) => b.total - a.total || a.customer.localeCompare(b.customer));
  return out;
}

export function summarise(rows) {
  const customers = new Set(rows.map((r) => r.customer_id || r.customer));
  return {
    total: rows.reduce((s, r) => s + r.open, 0),
    count: rows.length,
    customers: customers.size,
    oldest: rows.reduce((m, r) => Math.max(m, r.days_overdue), 0),
    over60: rows.filter((r) => r.days_overdue > 60).reduce((s, r) => s + r.open, 0),
  };
}

/*
  One customer's statement: every open item (or only the overdue invoices, if
  the caller asks), the ageing across the bottom, the balance due.
*/
export function buildStatement(data, customerKey, { overdueOnly = false } = {}) {
  const asAt = data?.as_at;
  const all = withAge(data?.items || [], asAt)
    .filter((i) => (i.customer_id || i.customer) === customerKey);
  const lines = sortByDue(overdueOnly
    ? all.filter((i) => isInvoice(i) && i.open > 0.004 && i.days_overdue > 0)
    : all);
  if (!lines.length) return null;

  const ageing = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
  for (const l of lines) ageing[l.bucket] += l.open;
  const balance = lines.reduce((s, l) => s + l.open, 0);
  const overdueGross = lines.filter((l) => isInvoice(l) && l.days_overdue > 0)
    .reduce((s, l) => s + l.open, 0);
  // A credit on the account reduces what is overdue as well as the balance —
  // never ask for more than the customer owes in total.
  const overdue = Math.max(0, Math.min(overdueGross, balance));

  const first = lines[0];
  const customer = (first.customer_id && data?.customers?.[first.customer_id])
    || { name: first.customer, address: null };

  return { as_at: asAt, currency: data?.currency || 'GBP', customer, lines, ageing, balance, overdue };
}

// A filename a person can find later: "Statement - Acme Ltd - 2026-09-30.pdf".
export function statementFilename(customerName, asAt) {
  const safe = String(customerName || 'Customer').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `Statement - ${safe} - ${asAt || ''}.pdf`;
}

// Address lines for printing, from the QuickBooks address shape.
// Bookkeepers often type the whole address into the street lines, so a town or
// postcode already in them is not printed a second time.
export function addressLines(a) {
  if (!a) return [];
  const lines = (a.lines || []).map((x) => String(x).trim()).filter(Boolean);
  const said = lines.join(' ').toLowerCase().replace(/\s+/g, '');
  const fresh = (x) => x && !said.includes(String(x).toLowerCase().replace(/\s+/g, ''));
  const town = [a.city, a.region].filter(fresh).join(', ');
  const country = a.country && !/^(gb|gbr|uk|united kingdom)$/i.test(a.country) && fresh(a.country) ? a.country : null;
  return [...lines, town, fresh(a.postcode) ? a.postcode : null, country].filter((x) => x && String(x).trim());
}
