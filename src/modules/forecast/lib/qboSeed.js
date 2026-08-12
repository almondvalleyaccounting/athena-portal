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

/** QBO report section → our generic category. */
function categoryFor(group, accountName) {
  switch (group) {
    case 'Income':
    case 'OtherIncome':
      return 'income';
    case 'COGS':
      return 'cost_of_sales';
    default:
      return PAYROLL_RE.test(accountName || '') ? 'payroll' : 'overheads';
  }
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

/**
 * Pull the client's monthly P&L for [start,end] and shape it into rows ready
 * for fc_pl_line. `defaultMethod` decides the basis: 'average' over the window,
 * 'last' month, or 'shape' (repeat the calendar-month pattern).
 *
 * Also returns the closing bank balance at the window end, which the Lines
 * view offers as the forecast's opening cash.
 */
export async function seedLinesFromQbo({ realmId, start, end, defaultMethod = 'average' }) {
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

  // Bank/cash at the window end, for the opening balance.
  const bs = payload?.metrics?.bs_period;
  const closingCashP = pickCash(bs);

  return { lines, months, closingCashP, currency: payload?.metrics?.pl_range?.currency || null };
}

/** Best-effort read of cash at bank from the balance-sheet payload. */
function pickCash(bs) {
  if (!bs) return null;
  const candidates = [bs.cash, bs.cash_p, bs.bank, bs.cash_at_bank];
  for (const c of candidates) {
    if (typeof c === 'number' && isFinite(c)) return Math.round(c * 100);
  }
  // Named-line map fallback: { lines: { 'Cash at bank and in hand': 1234.56 } }
  const lines = bs.lines || bs.groups;
  if (lines && typeof lines === 'object') {
    for (const [k, v] of Object.entries(lines)) {
      if (/cash|bank/i.test(k) && typeof v === 'number') return Math.round(v * 100);
    }
  }
  return null;
}
