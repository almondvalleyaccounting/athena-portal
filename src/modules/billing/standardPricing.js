// What a service costs at our standard rates, from the fee engine's
// current defaults (quote_defaults) and a client's pricing drivers.
//
// The formulas are the quote form's (hooks/useQuoteForm.js) with every
// per-quote override set back to the default — a change there must be
// made here too, or the fee review and New Quote will price the same
// client differently.
//
// Services whose price is a judgement per client (bookkeeping hours,
// management-account sets, review meetings, CFO days, software) have no
// standard and return null: the fee review leaves those lines alone. When
// one is added, BUILDERS below price it from its quantities instead.

// QBO item name → Athena service id. live_billing lines carry the QBO
// item's full name ("Accounts:Business Accounts and …"); the map holds
// the leaf. Two items map from two services each — prefer the primary.
const PRIMARY = { payroll: 1, bookkeeping_vat: 1 };

export function buildServiceResolver(maps) {
  const byLeaf = {};
  for (const m of maps || []) {
    const key = leaf(m.qbo_item_name);
    if (!key) continue;
    (byLeaf[key] = byLeaf[key] || []).push(m.service_id);
  }
  return (qboServiceId, description) => {
    const ids = byLeaf[leaf(qboServiceId)] || byLeaf[leaf(description)];
    if (!ids || !ids.length) return null;
    return ids.slice().sort((a, b) => (PRIMARY[b] || 0) - (PRIMARY[a] || 0))[0];
  };
}

const leaf = (s) => {
  const t = String(s || '');
  const i = t.lastIndexOf(':');
  return (i >= 0 ? t.slice(i + 1) : t).trim().toLowerCase();
};

// Drivers the standard price depends on. Blank means unknown.
export const EMPTY_DRIVERS = {
  turnover: '',          // £ a year — picks the accounts band
  accountsType: 'trading', // trading | dormant | property
  properties: 1,
  directors: '',         // directors' personal tax returns
  monthlyEmployees: '',
  weeklyEmployees: '',
};

const num = (v) => (v === '' || v == null ? null : Number(v));
const r2 = (n) => Math.round(n * 100) / 100;

// Standard price for one Athena service. Returns
//   { monthly, basis }      — priced; basis says how, for the tooltip
//   { missing: '<driver>' } — priceable once that driver is known
//   null                    — no standard for this service
export function standardFor(serviceId, drivers, D) {
  const d = drivers || EMPTY_DRIVERS;
  const yearly = (annual, basis) => ({ monthly: r2(annual / 12), basis });
  switch (serviceId) {
    case 'accounts_ct':
    case 'ltd_accounts': {
      if (d.accountsType === 'dormant') return yearly(D.dormant_rate, 'Dormant company rate');
      if (d.accountsType === 'property') {
        const n = Math.max(1, Number(d.properties) || 1);
        return yearly(D.property_base + (n - 1) * D.property_per_extra, `Property company, ${n} propert${n === 1 ? 'y' : 'ies'}`);
      }
      const t = num(d.turnover);
      if (t == null) return { missing: 'turnover' };
      const band = D.accounts_bands.find((b) => t >= b.min && t <= (b.max === Infinity ? 999999999 : b.max));
      return band ? yearly(band.rate, `Turnover band ${band.label}`) : { missing: 'turnover' };
    }
    case 'dormant_accounts':
      return yearly(D.dormant_rate, 'Dormant company rate');
    case 'property_accounts': {
      const n = Math.max(1, Number(d.properties) || 1);
      return yearly(D.property_base + (n - 1) * D.property_per_extra, `${n} propert${n === 1 ? 'y' : 'ies'}`);
    }
    case 'sole_trader_accounts':
      return yearly(D.sole_trader_accounts ?? 450, 'Sole trader accounts');
    case 'confirmation_statement':
      return yearly(D.confirmation_statement.fee, 'Confirmation statement, incl. Companies House fee');
    case 'directors_tax_return': {
      const n = num(d.directors);
      if (!n) return { missing: 'directors' };
      return yearly(n * D.director_base, `${n} director${n === 1 ? '' : 's'} × £${D.director_base} base return`);
    }
    case 'vat_returns':
      return yearly(4 * D.vat_per_return, `4 returns × £${D.vat_per_return}`);
    case 'mtd_returns': {
      const freq = D.mtd_returns?.freq ?? 4, rate = D.mtd_returns?.per_return ?? 35;
      return yearly(freq * rate, `${freq} returns × £${rate}`);
    }
    case 'payroll': {
      const m = num(d.monthlyEmployees), w = num(d.weeklyEmployees);
      if (m == null && w == null) return { missing: 'employees' };
      const p = D.payroll;
      const flat = Math.ceil((p.brightpay_annual / p.payroll_client_count) * (1 + p.markup_pct / 100));
      const monthly = flat + (m || 0) * p.monthly_ee_rate + (w || 0) * p.weekly_ee_rate * 4.33;
      const parts = [`£${flat} base`];
      if (m) parts.push(`${m} monthly × £${p.monthly_ee_rate}`);
      if (w) parts.push(`${w} weekly × £${p.weekly_ee_rate} × 4.33`);
      return { monthly: r2(monthly), basis: parts.join(' + ') };
    }
    case 'auto_enrolment':
      return yearly(D.auto_enrolment.standard, 'Auto-enrolment, standard');
    case 'registered_office':
      return yearly(D.registered_office, 'Registered office');
    default:
      return null;
  }
}

export const DRIVER_LABEL = {
  turnover: 'turnover',
  directors: 'number of directors',
  employees: 'employee count',
};

// Builders for services priced by quantity × rate, as New Quote builds them
// (hooks/useQuoteForm.js) — management accounts are sets a year × cost per
// set, bookkeeping is hours a month × hourly rate, and so on. Each builder
// lists its inputs with the fee engine's defaults, turns them into a monthly
// fee, and describes itself in a line the client reads on the letter.
//
// Rates default to the price book but stay editable, as on a quote.
const FREQ = [
  { value: 12, label: 'Monthly (12 a year)' },
  { value: 4, label: 'Quarterly (4 a year)' },
  { value: 2, label: 'Half-yearly (2 a year)' },
  { value: 1, label: 'Annually (1 a year)' },
];
const gbp = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perYear = (n, one, many) => `${n} ${Number(n) === 1 ? one : many} a year`;
const freqWord = (n) => ({ 12: 'monthly', 4: 'quarterly', 2: 'half-yearly', 1: 'annual' }[Number(n)] || `${n} a year`);

export const BUILDERS = {
  management_accounts: {
    fields: (D) => [
      { key: 'sets', label: 'How often', options: FREQ, default: 4 },
      { key: 'rate', label: 'Cost per set £', default: D.management_accounts_per_set || 158, step: 1 },
    ],
    monthly: (v) => (Number(v.sets) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => { const w = freqWord(v.sets); return `${w.charAt(0).toUpperCase()}${w.slice(1)} management accounts: ${perYear(v.sets, 'set', 'sets')} at ${gbp(v.rate)}`; },
  },
  review_meetings: {
    fields: (D) => [
      { key: 'count', label: 'Meetings a year', default: 4, step: 1 },
      { key: 'rate', label: 'Cost per meeting £', default: D.review_meeting_rate || 210, step: 1 },
    ],
    monthly: (v) => (Number(v.count) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => `${perYear(v.count, 'review meeting', 'review meetings')} at ${gbp(v.rate)}`,
  },
  bookkeeping_vat: {
    fields: (D) => [
      { key: 'hours', label: 'Hours a month', default: 8, step: 0.5 },
      { key: 'rate', label: 'Hourly rate £', default: D.bookkeeping_rate || 45, step: 1 },
    ],
    monthly: (v) => (Number(v.hours) || 0) * (Number(v.rate) || 0),
    describe: (v) => `${v.hours} hours a month at ${gbp(v.rate)} an hour`,
  },
  vat_returns: {
    fields: (D) => [
      { key: 'returns', label: 'Returns a year', default: 4, step: 1 },
      { key: 'rate', label: 'Cost per return £', default: D.vat_per_return || 45, step: 1 },
    ],
    monthly: (v) => (Number(v.returns) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => `${perYear(v.returns, 'VAT return', 'VAT returns')} at ${gbp(v.rate)}`,
  },
  mtd_returns: {
    fields: (D) => [
      { key: 'returns', label: 'Returns a year', default: D.mtd_returns?.freq ?? 4, step: 1 },
      { key: 'rate', label: 'Cost per return £', default: D.mtd_returns?.per_return ?? 35, step: 1 },
    ],
    monthly: (v) => (Number(v.returns) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => `${perYear(v.returns, 'MTD return', 'MTD returns')} at ${gbp(v.rate)}`,
  },
  directors_tax_return: {
    fields: (D) => [
      { key: 'count', label: 'Tax returns', default: 1, step: 1 },
      { key: 'rate', label: 'Cost per return £', default: D.director_base || 240, step: 1 },
    ],
    monthly: (v) => (Number(v.count) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => `${perYear(v.count, 'personal tax return', 'personal tax returns')} at ${gbp(v.rate)}`,
  },
  payroll: {
    fields: (D) => {
      const p = D.payroll;
      return [
        { key: 'base', label: 'Base £ / month', default: Math.ceil((p.brightpay_annual / p.payroll_client_count) * (1 + p.markup_pct / 100)), step: 1 },
        { key: 'monthly', label: 'Monthly-paid staff', default: 0, step: 1 },
        { key: 'weekly', label: 'Weekly-paid staff', default: 0, step: 1 },
        { key: 'mRate', label: '£ per monthly payslip', default: p.monthly_ee_rate, step: 0.1, advanced: true },
        { key: 'wRate', label: '£ per weekly payslip', default: p.weekly_ee_rate, step: 0.1, advanced: true },
      ];
    },
    monthly: (v) => (Number(v.base) || 0) + (Number(v.monthly) || 0) * (Number(v.mRate) || 0) + (Number(v.weekly) || 0) * (Number(v.wRate) || 0) * 4.33,
    describe: (v) => {
      const parts = [];
      if (Number(v.monthly)) parts.push(`${v.monthly} monthly-paid`);
      if (Number(v.weekly)) parts.push(`${v.weekly} weekly-paid`);
      return parts.length ? `Payroll for ${parts.join(' and ')} staff` : 'Payroll';
    },
  },
  fractional_cfo: {
    fields: (D) => [
      { key: 'days', label: 'Days a year', default: 12, step: 1 },
      { key: 'rate', label: 'Day rate £', default: D.cfo_day_rate || 1680, step: 10 },
    ],
    monthly: (v) => (Number(v.days) || 0) * (Number(v.rate) || 0) / 12,
    describe: (v) => `${perYear(v.days, 'day', 'days')} at ${gbp(v.rate)} a day`,
  },
  modulr: {
    fields: (D) => [
      { key: 'software', label: 'Software £ / month', default: D.modulr?.software_monthly_price ?? 20, step: 1 },
      { key: 'payments', label: 'Payments a month', default: 0, step: 1 },
      { key: 'runs', label: 'Pay runs a month', default: 0, step: 1 },
      { key: 'pRate', label: '£ per payment', default: D.modulr?.per_payment ?? 0.25, step: 0.05, advanced: true },
      { key: 'rRate', label: '£ per run', default: D.modulr?.per_run ?? 5, step: 0.5, advanced: true },
    ],
    monthly: (v) => (Number(v.software) || 0) + (Number(v.payments) || 0) * (Number(v.pRate) || 0) + (Number(v.runs) || 0) * (Number(v.rRate) || 0),
    describe: (v) => `Modulr wage payments${Number(v.payments) ? `, ${v.payments} payments a month` : ''}`,
  },
};
// Bookkeeping without VAT is built the same way.
BUILDERS.bookkeeping_novat = BUILDERS.bookkeeping_vat;

// A builder's starting values, from the fee engine's current defaults.
export function builderDefaults(serviceId, D) {
  const b = BUILDERS[serviceId];
  if (!b || !D) return null;
  return Object.fromEntries(b.fields(D).map((f) => [f.key, f.default]));
}

// { monthly, description } for a built service, or null.
export function priceBuild(serviceId, values, D) {
  const b = BUILDERS[serviceId];
  if (!b || !values) return null;
  return { monthly: Math.round(b.monthly(values, D) * 100) / 100, description: b.describe(values) };
}
