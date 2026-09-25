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
// standard and return null: the fee review leaves those lines alone.

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
