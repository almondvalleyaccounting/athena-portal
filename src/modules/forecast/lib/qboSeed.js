// Seed forecast lines from a client's QuickBooks P&L.
//
// Uses the EXISTING dashboard-qbo-pull edge function in its windowed mode —
// `window.kind:'custom'` returns a live monthly P&L for any date range and is
// never cached, which is exactly what a seed wants. Nothing is deployed for
// this; the account × month parse happens here, from the raw report the
// function already returns under `pl_range.report`.
//
// The seed produces one fc_pl_line per QuickBooks nominal account, mapped to a
// generic category. Categories are a first guess — the grid lets you move a
// line to another category, and a re-seed keeps that choice.

import { supabase } from '../../../lib/supabase';

/** Accounts whose name says "this is people cost" rather than a general overhead. */
const PAYROLL_RE = /(wage|salar|payroll|p\.?a\.?y\.?e|national insurance|employer'?s? ni|pension|staff cost|remunerat|subcontractor|sub-contractor)/i;

/**
 * Accounts the MODEL already produces, or that are not operating costs at all.
 * Seeding these as overheads would be doubly wrong: dividends are an
 * appropriation of profit rather than a cost, and corporation tax and loan
 * interest are computed by general_core and the loans module respectively —
 * carrying them as cost lines too would double-count them.
 *
 * They are still seeded (so nothing silently disappears) but switched OFF,
 * with a note saying why. Turning one back on is one click.
 */
const BELOW_THE_LINE = [
  { re: /(corporation tax|income tax provision|tax provision|deferred tax)/i,
    why: 'Excluded — the model calculates company tax from the forecast profit.' },
  { re: /(dividend|drawings)/i,
    why: 'Excluded — dividends are set in the Distributions assumption, not as a cost.' },
  { re: /(interest payable|loan interest|bank interest paid|finance charge)/i,
    why: 'Excluded — loan interest comes from the loans you set up.' },
  { re: /(depreciation|amortisation|amortization)/i,
    why: 'Excluded — a non-cash charge; capital spend is modelled directly.' },
];

function belowTheLine(name) {
  return BELOW_THE_LINE.find(b => b.re.test(name || '')) || null;
}

/*
  QBO report section → our generic category.

  The section decides income vs cost; the account NAME decides whether a cost
  is people cost. Both halves matter, and the name has to be consulted for
  every cost section rather than just for Expenses.

  This is not fussiness. Plenty of clients post wages, employer's NI and
  employer's pension to accounts QuickBooks types as Cost of Goods Sold —
  Puddleduck does, and for a nursery it is defensible bookkeeping, staff being
  the direct cost of the service. But the Projection tab puts forecast columns
  beside ACTUAL columns, and the actuals side
  (projectionMapping.defaultActualCategory) reads the name before the type, so
  it files those same accounts under Staff costs. Seeding on the section alone
  put £222k of wages into the forecast's Cost of sales and left Staff costs at
  nil, which read as the model having lost the payroll — two columns of the one
  table disagreeing about the one account.

  It also gets the VAT treatment right by consequence: `payroll` seeds as
  outside the scope of VAT, which wages are wherever they are posted.
*/
function categoryFor(group, accountName) {
  if (group === 'Income' || group === 'OtherIncome') return 'income';
  if (PAYROLL_RE.test(accountName || '')) return 'payroll';
  if (group === 'COGS') return 'cost_of_sales';
  return 'overheads';
}

/** Connections available to seed from, newest first. */
export async function listQboConnections() {
  const { data, error } = await supabase
    .from('qbo_report_connections')
    .select('realm_id, company_name, entity_id, status, is_practice')
    .eq('status', 'active')
    .order('company_name');
  if (error) throw error;
  return (data || []).filter(c => !c.is_practice);
}

/** The connection for a client entity, if there is one. */
export async function qboConnectionForEntity(entity_id) {
  if (!entity_id) return null;
  const { data, error } = await supabase
    .from('qbo_report_connections')
    .select('realm_id, company_name, entity_id, status, is_practice')
    .eq('entity_id', entity_id).eq('status', 'active').maybeSingle();
  if (error) throw error;
  return data || null;
}

/** 'Sep 2025' / 'Sep 2025' style column titles → 'YYYY-MM'. */
function monthKey(colTitle) {
  const d = new Date(`1 ${colTitle}`);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // QBO sometimes returns an ISO date range as the title instead.
  const iso = String(colTitle).match(/(\d{4})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}` : String(colTitle);
}

/**
 * Parse a monthly ProfitAndLoss report into per-account monthly series.
 * Returns [{ qbo_account_id, qbo_account_name, qbo_group, months, amounts_p }].
 */
export function parseMonthlyPl(report) {
  const cols = (report?.Columns?.Column || []).map(c => c.ColTitle ?? '');
  const monthTitles = cols.slice(1).filter(t => !/^total$/i.test(t));
  const months = monthTitles.map(monthKey);
  const n = months.length;
  if (n === 0) return { months: [], accounts: [] };

  const accounts = [];
  const walk = (rows, group) => {
    for (const r of rows || []) {
      const g = r.group || group;
      // Leaf account rows carry ColData; section summaries carry Summary.
      if (r.ColData && Array.isArray(r.ColData) && r.type !== 'Section') {
        const c0 = r.ColData[0] || {};
        const name = c0.value || '';
        if (name) {
          const amounts_p = r.ColData.slice(1, 1 + n).map(c => {
            const v = parseFloat(c?.value ?? '');
            return isNaN(v) ? 0 : Math.round(v * 100);
          });
          if (amounts_p.some(a => a !== 0)) {
            accounts.push({
              qbo_account_id: c0.id ? String(c0.id) : null,
              qbo_account_name: name,
              qbo_group: g || null,
              months,
              amounts_p,
            });
          }
        }
      }
      if (r.Rows?.Row) walk(r.Rows.Row, g);
    }
  };
  walk(report?.Rows?.Row || [], null);

  return { months, accounts };
}

/** Last day of the month BEFORE a forecast's opening period, as YYYY-MM-DD. */
export function lastActualMonthEnd(openingPeriod) {
  const d = openingPeriod ? new Date(openingPeriod) : new Date();
  // Day 0 of the opening month = last day of the month before it.
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return end.toISOString().slice(0, 10);
}

/**
 * Pull the client's monthly P&L for [start,end] and shape it into rows ready
 * for fc_pl_line. `defaultMethod` decides the basis: 'average' over the window,
 * 'last' month, or 'shape' (repeat the calendar-month pattern).
 *
 * Also returns the OPENING POSITION: the balance sheet as at the end of the
 * last actual month before the forecast starts, so month 0 begins exactly
 * where the real accounts finished rather than at an arbitrary date.
 */
export async function seedLinesFromQbo({ realmId, start, end, defaultMethod = 'average', openingPeriod = null }) {
  const asAt = openingPeriod ? lastActualMonthEnd(openingPeriod) : end;
  const { data: payload, error } = await supabase.functions.invoke('dashboard-qbo-pull', {
    body: {
      realmId,
      window: {
        kind: 'custom',
        period: {
          plStart: start, plEnd: end,
          priorStart: start, priorEnd: end,      // unused here; the function requires the pair
          chartStart: start, chartEnd: end,
        },
        // Balance sheet + aged debt as at the last actual month end.
        asat: { date: asAt },
      },
    },
  });
  if (error) throw new Error(error.message || 'QuickBooks pull failed');
  if (payload?.errors?.pl_range) throw new Error(payload.errors.pl_range);

  const report = payload?.metrics?.pl_range?.report;
  if (!report) throw new Error('QuickBooks returned no monthly P&L for that period.');

  const { months, accounts } = parseMonthlyPl(report);
  if (accounts.length === 0) throw new Error('No account activity in that period.');

  const lines = accounts.map((a, i) => {
    const total = a.amounts_p.reduce((s, v) => s + v, 0);
    const avg = months.length ? total / months.length : 0;
    const last = a.amounts_p[a.amounts_p.length - 1] || 0;
    const category = categoryFor(a.qbo_group, a.qbo_account_name);
    const excluded = belowTheLine(a.qbo_account_name);
    return {
      category,
      label: a.qbo_account_name,
      qbo_account_id: a.qbo_account_id,
      qbo_account_name: a.qbo_account_name,
      qbo_group: a.qbo_group,
      actuals: { months: a.months, amounts_p: a.amounts_p, source: { realmId, start, end } },
      method: defaultMethod,
      base_amount_p: Math.round(defaultMethod === 'last' ? last : avg),
      uplift_pct: 0,
      delta_p: 0,
      growth_pct_pa: 0,
      // Wages are outside the scope of VAT; everything else starts standard-rated
      // and can be changed per line (insurance, bank charges, rent…).
      vat_treatment: category === 'payroll' || excluded ? 'outside' : 'standard',
      sort_order: (i + 1) * 10,
      is_active: !excluded,
      notes: excluded ? excluded.why : null,
    };
  });

  // The opening position, from the balance sheet as at the last actual month.
  const bs = payload?.metrics?.bs_asat || payload?.metrics?.bs_period;
  const opening = openingPositionFrom(bs, asAt);

  return {
    lines, months, opening,
    closingCashP: opening?.cash_p ?? null,     // kept for the older caller shape
    currency: payload?.metrics?.pl_range?.currency || null,
  };
}

/** Pence, from a QBO balance-sheet figure in pounds. */
const toP = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null);

/**
 * Opening balances for the forecast, read from the as-at balance sheet.
 *
 * "Other liabilities" is current + long-term liabilities LESS trade creditors,
 * which the model tracks itself. Caution: it therefore still includes any VAT,
 * payroll-tax, tax and loan balances sitting in the client's books — so if you
 * also enter an existing loan on the Lending side, or an opening VAT/tax
 * liability, reduce this figure by the same amount or it counts twice.
 * Floored at zero: a negative would mean the QBO groups overlap unexpectedly,
 * and a silent negative liability is worse than none.
 */
export function openingPositionFrom(bs, asAt) {
  if (!bs) return null;
  const warnings = [];
  const cash_p = toP(bs.cash);
  const rawDebtors = toP(bs.debtors) || 0;
  const rawCreditors = toP(bs.accounts_payable) || 0;
  const fixed_p = (toP(bs.fixed_assets) || 0) + (toP(bs.other_assets) || 0);

  // A NEGATIVE debtor balance is not a negative asset — it is money held on
  // account (customers in credit, or income invoiced in advance). Carrying it
  // as debtors would have the model "collect" it, i.e. pay cash out, in the
  // first month or two. Park it in other liabilities instead, where it sits
  // inert, and say so rather than quietly changing the client's figure.
  const debtors_p = Math.max(0, rawDebtors);
  const customerCredits = rawDebtors < 0 ? -rawDebtors : 0;
  if (customerCredits) {
    warnings.push(`Debtors came back negative (${formatP(rawDebtors)}) — customers in credit or income billed in advance. Treated as a liability, not as cash to collect. Worth checking the client's sales ledger.`);
  }

  const creditors_p = Math.max(0, rawCreditors);
  const supplierCredits = rawCreditors < 0 ? -rawCreditors : 0;
  if (supplierCredits) {
    warnings.push(`Trade creditors came back negative (${formatP(rawCreditors)}) — treated as nil.`);
  }

  const currentLiab = toP(bs.creditors_within_1yr) || 0;
  const longLiab = toP(bs.creditors_after_1yr) || 0;
  const other_liabilities_p =
    Math.max(0, currentLiab + longLiab - creditors_p) + customerCredits;

  return {
    as_at: asAt,
    cash_p,
    debtors_p,
    creditors_p,
    fixed_assets_p: fixed_p,
    other_liabilities_p,
    net_assets_p: toP(bs.net_assets ?? bs.equity),
    warnings,
  };
}

const formatP = (p) => (p < 0 ? '-' : '') + '£' + Math.abs(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
