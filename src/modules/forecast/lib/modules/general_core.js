// General core — the P&L and cash engine for the GENERAL CASHFLOW lens.
//
// Takes the raw line rows from pl_lines (plus loan rows) and produces:
//   • a signed monthly P&L (generic labels — Sales, Cost of sales, Payroll,
//     Overheads — never industry-specific ones),
//   • a receipts-and-payments cashflow with debtor/creditor lag, the PAYE
//     split, the VAT quarter cycle and Corporation Tax,
//   • a closing bank balance.
//
// P&L and cash in ONE module on purpose: Corporation Tax is a cash item whose
// size comes from the P&L, so splitting them would make the two halves
// mutually dependent.
//
// Conventions inherited from the childcare pack: raw rows are positive
// magnitudes, `pnl.cost_*` and `cf.out.*` rows are stored NEGATIVE.
//
// VAT is modelled on the STANDARD (invoice) basis — liability accrues in the
// month of the invoice, not the month of payment — because that is what the
// accrual P&L the lines are seeded from represents. Cash in and out is gross.

import { formatMoney } from '../currency.js';

const DAYS_PER_MONTH = 30.44;

/**
 * Bunch a monthly stream into a quarterly or annual payment.
 *
 * Amounts accumulate and are released at `offset`, then every cycle after it —
 * so a developer invoicing monthly but paid quarterly costs the P&L every
 * month while the cash leaves in one lump every third. Anything still in the
 * bucket at the horizon stays unpaid, which is correct: it is a creditor the
 * forecast has not yet reached.
 */
export function applyCadence(due, { cadence, offset }, T) {
  if (!cadence || cadence === 'monthly') return due;
  const cycle = cadence === 'annual' ? 12 : 3;
  const off = ((Number(offset) || 0) % cycle + cycle) % cycle;
  const out = new Array(T).fill(0);
  let bucket = 0;
  for (let t = 0; t < T; t++) {
    bucket += due[t];
    if (t >= off && (t - off) % cycle === 0) { out[t] = bucket; bucket = 0; }
  }
  return out;
}

/**
 * Part-payment: settle up to a cap (or a share) each month, let the rest build
 * as arrears, and clear the lot from the settlement month onwards.
 *
 * The cap applies to what is available — this month's due PLUS anything
 * already outstanding — so a light month naturally catches up on arrears
 * rather than leaving them stranded. A percentage applies to the month's own
 * due only, which is what "they pay 70% of each invoice" means.
 */
export function applyArrears(due, { capP, pct, settleMonth }, T) {
  const hasCap = capP != null && Number(capP) > 0;
  const hasPct = !hasCap && pct != null && Number(pct) < 100;
  if (!hasCap && !hasPct) return due;

  const cap = Number(capP), share = Number(pct) / 100;
  const settle = settleMonth == null ? null : Number(settleMonth);
  const paid = new Array(T).fill(0);
  let arrears = 0;

  for (let t = 0; t < T; t++) {
    const available = due[t] + arrears;
    let p;
    if (settle != null && t >= settle) {
      // The plan is over: clear everything outstanding and settle in full.
      p = available;
    } else if (hasCap) {
      p = Math.min(available, cap);
    } else {
      p = due[t] * share;
    }
    p = Math.max(0, Math.min(p, available));
    paid[t] = p;
    arrears = available - p;
  }
  return paid;
}

export const generalCoreModule = {
  key: 'general_core',
  pack: ['general_cashflow'],
  dependsOn: ['pl_lines', 'loans'],
  drivers: [
    // ─── Opening position ───
    // Seeded from the client's balance sheet as at the last actual month, so
    // month 0 of the forecast starts where the real accounts finished.
    { key: 'cash.opening_balance_p',        label: 'Opening bank balance', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'bs.opening_debtors_p',          label: 'Opening debtors (owed to us)', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'bs.opening_creditors_p',        label: 'Opening creditors (we owe)', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'bs.opening_fixed_assets_p',     label: 'Opening fixed assets', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'bs.opening_other_liabilities_p', label: 'Other opening liabilities', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },

    // ─── Working capital ───
    { key: 'wc.debtor_days',   label: 'Debtor days (customers pay in)', unit: 'days', kind: 'scalar', scope: 'group', defaultValue: 30 },
    { key: 'wc.creditor_days', label: 'Creditor days (we pay suppliers in)', unit: 'days', kind: 'scalar', scope: 'group', defaultValue: 30 },

    // ─── Payroll ───
    { key: 'payroll.paye_share_pct', label: 'PAYE/NI/pension as % of payroll cost (paid a month in arrears)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 30 },

    // ─── VAT / sales tax ───
    { key: 'vat.registered',    label: 'Registered for VAT / sales tax (1 = yes, 0 = no)', unit: 'flag', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'vat.rate_pct',      label: 'Standard rate %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 20 },
    { key: 'vat.flat_rate_pct', label: 'Flat Rate Scheme % (0 = standard scheme)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'vat.stagger',       label: 'Return quarter stagger (1 = Jan/Apr/Jul/Oct, 2 = Feb/May/Aug/Nov, 3 = Mar/Jun/Sep/Dec)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'vat.payment_lag_months', label: 'Months after quarter end that it is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'vat.opening_liability_p', label: 'Owed at the start', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'vat.opening_due_month',   label: 'Month that opening balance is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },

    // ─── Company income tax (UK Corporation Tax, US federal/state, …) ───
    { key: 'tax.ct_rate_pct',           label: 'Company tax rate % (UK CT 25, US federal 21)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 25 },
    { key: 'tax.year_end_month',        label: 'Accounting year-end month (1-12)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'tax.payment_pattern',       label: 'Payment pattern (0 = one payment after year end, 1 = quarterly instalments)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'tax.ct_payment_lag_months', label: 'Months after year end / quarter that tax is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 9 },
    { key: 'tax.ct_opening_liability_p', label: 'Tax owed at the start', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'tax.ct_opening_due_month',   label: 'Month the opening tax is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },

    // ─── Distributions ───
    { key: 'div.monthly_p', label: 'Dividends / drawings per month', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
  ],
  outputs: [
    { nominal_type: 'pnl.revenue_total',  label: 'Sales', by_entity: false },
    { nominal_type: 'pnl.cost_of_sales',  label: 'Cost of sales', by_entity: false },
    { nominal_type: 'pnl.gross_profit',   label: 'Gross profit', by_entity: false },
    { nominal_type: 'pnl.cost_payroll',   label: 'Payroll', by_entity: false },
    { nominal_type: 'pnl.cost_overheads', label: 'Overheads', by_entity: false },
    { nominal_type: 'pnl.cost_total',     label: 'Total costs', by_entity: false },
    { nominal_type: 'pnl.ebitda',         label: 'EBITDA', by_entity: false },
    { nominal_type: 'pnl.interest_total', label: 'Interest', by_entity: false },
    { nominal_type: 'pnl.pbt',            label: 'Profit before tax', by_entity: false },
    { nominal_type: 'pnl.tax_total',      label: 'Corporation Tax', by_entity: false },
    { nominal_type: 'pnl.npat',           label: 'Profit after tax', by_entity: false },
    { nominal_type: 'pnl.dividends',      label: 'Dividends', by_entity: false },

    { nominal_type: 'cf.opening_cash',     label: 'Opening bank', by_entity: false },
    { nominal_type: 'cf.in.receipts',      label: 'Receipts from customers', by_entity: false },
    { nominal_type: 'cf.in.vat_refund',    label: 'VAT refund', by_entity: false },
    { nominal_type: 'cf.in.debt_drawdown', label: 'Loan drawdown', by_entity: false },
    { nominal_type: 'cf.in_total',         label: 'Total cash in', by_entity: false },
    { nominal_type: 'cf.out.cost_of_sales', label: 'Payments to suppliers', by_entity: false },
    { nominal_type: 'cf.out.payroll',      label: 'Net wages', by_entity: false },
    { nominal_type: 'cf.out.paye',         label: 'PAYE / NI / pension', by_entity: false },
    { nominal_type: 'cf.out.overheads',    label: 'Overheads paid', by_entity: false },
    { nominal_type: 'cf.out.vat',          label: 'VAT paid', by_entity: false },
    { nominal_type: 'cf.out.corp_tax',     label: 'Corporation Tax paid', by_entity: false },
    { nominal_type: 'cf.out.capex',        label: 'Capital spend', by_entity: false },
    { nominal_type: 'cf.out.interest',     label: 'Loan interest', by_entity: false },
    { nominal_type: 'cf.out.debt_principal', label: 'Loan repayments', by_entity: false },
    { nominal_type: 'cf.out.dividends',    label: 'Dividends / drawings', by_entity: false },
    { nominal_type: 'cf.out_total',        label: 'Total cash out', by_entity: false },
    { nominal_type: 'cf.net_movement',     label: 'Net cash movement', by_entity: false },
    { nominal_type: 'cf.closing_cash',     label: 'Closing bank', by_entity: false },

    { nominal_type: 'pnl.vat_frs_benefit',  label: 'VAT flat-rate benefit', by_entity: false },
    { nominal_type: 'cf.line',              label: 'Cash movement by line', by_entity: false },

    { nominal_type: 'bs.fixed_assets',      label: 'Fixed assets', by_entity: false },
    { nominal_type: 'bs.cash',              label: 'Cash', by_entity: false },
    { nominal_type: 'bs.debtors',           label: 'Debtors', by_entity: false },
    { nominal_type: 'bs.current_assets',    label: 'Total current assets', by_entity: false },
    { nominal_type: 'bs.total_assets',      label: 'Total assets', by_entity: false },
    { nominal_type: 'bs.creditors',         label: 'Trade creditors', by_entity: false },
    { nominal_type: 'bs.payroll_creditor',  label: 'Payroll taxes owed', by_entity: false },
    { nominal_type: 'bs.vat_liability',     label: 'VAT owed', by_entity: false },
    { nominal_type: 'bs.tax_liability',     label: 'Company tax owed', by_entity: false },
    { nominal_type: 'bs.loans',             label: 'Loans outstanding', by_entity: false },
    { nominal_type: 'bs.other_liabilities', label: 'Other liabilities', by_entity: false },
    { nominal_type: 'bs.total_liabilities', label: 'Total liabilities', by_entity: false },
    { nominal_type: 'bs.current_liabilities', label: 'Total current liabilities', by_entity: false },
    { nominal_type: 'bs.non_current_liabilities', label: 'Total non-current liabilities', by_entity: false },
    { nominal_type: 'bs.debt',              label: 'Total debt', by_entity: false },
    { nominal_type: 'bs.net_assets',        label: 'Net assets', by_entity: false },
    { nominal_type: 'bs.equity',            label: 'Equity', by_entity: false },
    { nominal_type: 'bs.check',             label: 'Balance check', by_entity: false },

    { nominal_type: 'metric.vat_liability', label: 'VAT owed', by_entity: false },
    { nominal_type: 'metric.ct_liability',  label: 'CT owed', by_entity: false },
    { nominal_type: 'metric.debtors',       label: 'Money owed to us', by_entity: false },
    { nominal_type: 'metric.creditors',     label: 'Money we owe', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    const T = ctx.periods.length;
    const zeros = () => new Array(T).fill(0);
    const r = (key) => Number(ctx.resolve(key, {})) || 0;

    const openingCash = r('cash.opening_balance_p');
    const debtorDays = r('wc.debtor_days');
    const creditorDays = r('wc.creditor_days');
    const payeShare = Math.min(1, Math.max(0, r('payroll.paye_share_pct') / 100));
    const vatRegistered = r('vat.registered') === 1;
    const vatRate = r('vat.rate_pct') / 100;
    const frsRate = r('vat.flat_rate_pct') / 100;
    const onFrs = vatRegistered && frsRate > 0;
    const stagger = Math.min(3, Math.max(1, Math.round(r('vat.stagger')) || 3));
    const vatLag = Math.max(0, Math.round(r('vat.payment_lag_months')));
    const ctRate = r('tax.ct_rate_pct') / 100;
    const yearEndMonth = Math.min(12, Math.max(1, Math.round(r('tax.year_end_month')) || 3));
    const ctLag = Math.max(0, Math.round(r('tax.ct_payment_lag_months')));
    const ctPattern = Math.round(r('tax.payment_pattern')) === 1 ? 1 : 0;
    const dividendsPm = r('div.monthly_p');

    // ── Calendar ────────────────────────────────────────────────────
    const openingDate = ctx.forecast?.opening_period ? new Date(ctx.forecast.opening_period) : new Date();
    const monthOf = (t) => ((openingDate.getUTCMonth() + t) % 12) + 1;   // 1-12

    // ── Bucket the raw line rows ────────────────────────────────────
    const rows = ctx.upstreamOutputs.filter(o => o.module_key === 'pl_lines');
    const revenue = zeros(), cos = zeros(), payroll = zeros(), overheads = zeros(), capex = zeros();
    // Gross (VAT-inclusive) cash effect of each line, spread by its own lag.
    const receipts = zeros(), payCos = zeros(), payOverheads = zeros(), payCapex = zeros();
    // VAT accruals, on the invoice basis (month of the P&L line).
    const outputVat = zeros(), inputVat = zeros();

    // Per-LINE cash, so the cashflow statement can show the same lines the
    // user edits on the Lines tab rather than four opaque totals — and so each
    // line's own cash timing (cadence, cap, arrears) can be applied to it
    // before anything is added up.
    // Map: line_id -> { label, category, due[], timing }
    const byLine = new Map();
    const lineSeries = (row) => {
      const id = row.tags?.line_id || row.line_label;
      let entry = byLine.get(id);
      if (!entry) {
        entry = {
          id, label: row.line_label,
          category: row.tags?.category || 'overheads',
          due: zeros(),           // gross cash owed, after the lag
          cash: zeros(),          // signed cash actually moving, after timing
          timing: {
            cadence: row.tags?.cadence || 'monthly',
            offset: Number(row.tags?.cadence_offset) || 0,
            capP: row.tags?.cap_p ?? null,
            pct: row.tags?.collect_pct ?? null,
            settleMonth: row.tags?.settle_month ?? null,
          },
        };
        byLine.set(id, entry);
      }
      return entry;
    };

    /** Add `amount` to `series`, delayed by `days`, splitting across the two months it straddles. */
    const spread = (series, t, amount, days) => {
      const lagMonths = (Number(days) || 0) / DAYS_PER_MONTH;
      const whole = Math.floor(lagMonths);
      const frac = lagMonths - whole;
      const a = t + whole, b = a + 1;
      if (a >= 0 && a < T) series[a] += amount * (1 - frac);
      if (b >= 0 && b < T) series[b] += amount * frac;
    };

    for (const row of rows) {
      const t = row.period;
      if (t < 0 || t >= T) continue;
      const amt = Number(row.amount_p) || 0;
      const cat = row.tags?.category || 'overheads';
      const vatable = vatRegistered && (row.tags?.vat || 'standard') === 'standard';
      const lineLag = row.tags?.lag_days;

      const entry = lineSeries(row);

      if (cat === 'income') {
        revenue[t] += amt;
        const vat = vatable ? amt * vatRate : 0;
        outputVat[t] += vat;
        spread(entry.due, t, amt + vat, lineLag == null ? debtorDays : lineLag);
      } else if (cat === 'payroll') {
        // No VAT on wages, and the cash split is the PAYE timing below.
        payroll[t] += amt;
        // Net pay this month, the PAYE share next — same split as the totals.
        entry.cash[t] -= amt * (1 - payeShare);
        if (t + 1 < T) entry.cash[t + 1] -= amt * payeShare;
      } else {
        const vat = vatable ? amt * vatRate : 0;
        // Under the Flat Rate Scheme input VAT is not reclaimable (the
        // capital-goods exception above £2,000 is not modelled).
        if (!onFrs) inputVat[t] += vat;
        const lag = lineLag == null ? creditorDays : lineLag;
        if (cat === 'cost_of_sales') cos[t] += amt;
        else if (cat === 'capex') capex[t] += amt;
        else overheads[t] += amt;
        spread(entry.due, t, amt + vat, lag);
      }
    }

    // ── Per-line cash timing ────────────────────────────────────────
    // What is owed after the lag is not always what moves. Two transforms,
    // applied in this order because bunching happens before any cap bites:
    //   cadence — a quarterly-paid supplier: accumulate, release on cycle
    //   arrears — part-payment: pay up to a cap (or a share), the rest builds
    //             until the settlement month clears it
    // Payroll is excluded from both: wages and PAYE have their own statutory
    // timing, already handled above.
    for (const entry of byLine.values()) {
      if (entry.category === 'payroll') continue;
      const afterCadence = applyCadence(entry.due, entry.timing, T);
      const paid = applyArrears(afterCadence, entry.timing, T);
      const sign = entry.category === 'income' ? 1 : -1;
      const target = entry.category === 'income' ? receipts
        : entry.category === 'cost_of_sales' ? payCos
        : entry.category === 'capex' ? payCapex
        : payOverheads;
      for (let t = 0; t < T; t++) {
        target[t] += paid[t];
        entry.cash[t] += sign * paid[t];
      }
    }

    // ── Opening working capital ─────────────────────────────────────
    // What the client was owed and owed on day one settles over the same lag
    // as new business, so month 1 isn't artificially cash-rich.
    const openingDebtors = r('bs.opening_debtors_p');
    const openingCreditors = r('bs.opening_creditors_p');
    const openingFixed = r('bs.opening_fixed_assets_p');
    const openingOtherLiab = r('bs.opening_other_liabilities_p');
    const openingDebtorReceipts = zeros(), openingCreditorPayments = zeros();
    if (openingDebtors) spread(openingDebtorReceipts, 0, openingDebtors, debtorDays);
    if (openingCreditors) spread(openingCreditorPayments, 0, openingCreditors, creditorDays);

    // Payroll cash: net pay in the month, PAYE/NI/pension a month in arrears.
    const netWages = zeros(), payeCash = zeros();
    for (let t = 0; t < T; t++) {
      netWages[t] += payroll[t] * (1 - payeShare);
      if (t + 1 < T) payeCash[t + 1] += payroll[t] * payeShare;
    }

    // ── Loans ───────────────────────────────────────────────────────
    const interest = zeros(), principal = zeros(), drawdown = zeros();
    const debtBalance = zeros();
    for (const o of ctx.upstreamOutputs) {
      if (o.module_key !== 'loans' || o.period < 0 || o.period >= T) continue;
      if (o.nominal_type === 'debt_interest') interest[o.period] += Number(o.amount_p) || 0;
      if (o.nominal_type === 'debt_principal') principal[o.period] += Number(o.amount_p) || 0;
      if (o.nominal_type === 'debt_balance') debtBalance[o.period] += Number(o.amount_p) || 0;
    }
    for (let t = 0; t < T; t++) {
      const prev = t === 0 ? 0 : debtBalance[t - 1];
      // A rise in the balance net of what was repaid that month is new money in.
      drawdown[t] = Math.max(0, debtBalance[t] - prev + principal[t]);
    }

    // ── VAT cycle ───────────────────────────────────────────────────
    // Accrue per month, settle the quarter's net liability `vatLag` months
    // after the quarter ends. FRS pays a flat % of GROSS (VAT-inclusive) sales.
    const vatPayment = zeros(), vatRefund = zeros();
    const vatAccrual = zeros();
    if (vatRegistered) {
      for (let t = 0; t < T; t++) {
        vatAccrual[t] = onFrs
          ? (revenue[t] + outputVat[t]) * frsRate
          : outputVat[t] - inputVat[t];
      }
      // Quarter ends are the months where (month - stagger) is divisible by 3.
      let bucket = 0;
      for (let t = 0; t < T; t++) {
        bucket += vatAccrual[t];
        const m = monthOf(t);
        const isQuarterEnd = ((m - stagger) % 3 + 3) % 3 === 0;
        if (isQuarterEnd) {
          const payAt = t + vatLag;
          if (payAt >= 0 && payAt < T) {
            if (bucket >= 0) vatPayment[payAt] += bucket; else vatRefund[payAt] += -bucket;
          }
          bucket = 0;
        }
      }
    }
    const openingVat = r('vat.opening_liability_p');
    const openingVatMonth = Math.max(0, Math.round(r('vat.opening_due_month')));
    if (openingVat && openingVatMonth < T) vatPayment[openingVatMonth] += openingVat;

    // ── P&L ─────────────────────────────────────────────────────────
    // Under the Flat Rate Scheme the company keeps the difference between the
    // VAT it charges and the flat percentage it hands over, and bears its own
    // input VAT. That net is real profit (and taxable), so it appears as its
    // own line rather than vanishing — which is also what keeps the balance
    // sheet balancing under FRS.
    const frsBenefit = zeros();
    if (onFrs) {
      for (let t = 0; t < T; t++) frsBenefit[t] = outputVat[t] - inputVat[t] - vatAccrual[t];
    }

    const grossProfit = zeros(), costTotal = zeros(), ebitda = zeros(), pbt = zeros();
    const ctCharge = zeros(), npat = zeros();
    let lossCarryforward = 0;
    for (let t = 0; t < T; t++) {
      grossProfit[t] = revenue[t] - cos[t];
      costTotal[t] = cos[t] + payroll[t] + overheads[t];
      ebitda[t] = revenue[t] - costTotal[t] + frsBenefit[t];
      pbt[t] = ebitda[t] - interest[t];
      // Monthly CT accrual with losses carried forward — the same simple
      // basis tax_simple uses for the childcare pack.
      if (pbt[t] > 0) {
        const taxable = Math.max(0, pbt[t] - lossCarryforward);
        lossCarryforward = Math.max(0, lossCarryforward - pbt[t]);
        ctCharge[t] = taxable * ctRate;
      } else {
        lossCarryforward += -pbt[t];
        ctCharge[t] = 0;
      }
      npat[t] = pbt[t] - ctCharge[t];
    }

    // ── Company tax payments ────────────────────────────────────────
    // Two patterns, because not every company pays like a UK small company:
    //   0 — one payment `ctLag` months after the year end (UK CT)
    //   1 — quarterly instalments: each quarter of the tax year settles
    //       `ctLag` months after that quarter ends. This approximates US
    //       estimated payments (due in months 4/6/9/12 of the tax year) and
    //       UK quarterly instalments for large companies; it is deliberately
    //       an approximation, not a filing-grade schedule.
    const ctPayment = zeros();
    let ctBucket = 0;
    if (ctPattern === 1) {
      for (let t = 0; t < T; t++) {
        ctBucket += ctCharge[t];
        // Months since the year end define the quarter boundaries.
        const monthsIntoYear = ((monthOf(t) - yearEndMonth) % 12 + 12) % 12;   // 0 = year end month
        if (monthsIntoYear % 3 === 0) {
          const payAt = t + ctLag;
          if (payAt >= 0 && payAt < T) ctPayment[payAt] += ctBucket;
          ctBucket = 0;
        }
      }
    } else {
      for (let t = 0; t < T; t++) {
        ctBucket += ctCharge[t];
        if (monthOf(t) === yearEndMonth) {
          const payAt = t + ctLag;
          if (payAt >= 0 && payAt < T) ctPayment[payAt] += ctBucket;
          ctBucket = 0;
        }
      }
    }
    const openingCt = r('tax.ct_opening_liability_p');
    const openingCtMonth = Math.max(0, Math.round(r('tax.ct_opening_due_month')));
    if (openingCt && openingCtMonth < T) ctPayment[openingCtMonth] += openingCt;

    // ── Cash ────────────────────────────────────────────────────────
    const dividends = zeros();
    for (let t = 0; t < T; t++) dividends[t] = dividendsPm;

    let cash = openingCash;
    let vatOwed = openingVat, ctOwed = openingCt;
    let debtors = openingDebtors, creditors = openingCreditors;
    let payrollCreditor = 0, fixedAssets = openingFixed;

    // Opening equity is DERIVED, exactly as the childcare pack derives it from
    // opening cash: whatever makes the opening balance sheet balance. That way
    // month 0 ties by construction and every later month ties because each
    // movement touches both sides.
    const openingEquity = (openingCash + openingDebtors + openingFixed)
      - (openingCreditors + openingVat + openingCt + openingOtherLiab);
    let equity = openingEquity;

    const emit = (t, nominal_type, line_label, amount_p, tags) => {
      out.push({ module_key: 'general_core', period: t, nominal_type, line_label,
        amount_p: Math.round(amount_p), ...(tags ? { tags } : {}) });
    };

    for (let t = 0; t < T; t++) {
      const cashIn = receipts[t] + openingDebtorReceipts[t] + vatRefund[t] + drawdown[t];
      const cashOut = payCos[t] + openingCreditorPayments[t] + netWages[t] + payeCash[t] + payOverheads[t]
        + vatPayment[t] + ctPayment[t] + payCapex[t] + interest[t] + principal[t] + dividends[t];
      const opening = cash;
      cash = opening + cashIn - cashOut;

      // Running balances — what is owed to and by the company at month end.
      const grossSales = revenue[t] + outputVat[t];
      const grossCosts = cos[t] + overheads[t] + capex[t] + (onFrs ? 0 : inputVat[t]);
      debtors += grossSales - receipts[t] - openingDebtorReceipts[t];
      creditors += grossCosts - (payCos[t] + payOverheads[t] + payCapex[t]) - openingCreditorPayments[t];
      payrollCreditor += payroll[t] * payeShare - payeCash[t];
      vatOwed += vatAccrual[t] - vatPayment[t] + vatRefund[t];
      ctOwed += ctCharge[t] - ctPayment[t];
      fixedAssets += capex[t];
      equity += npat[t] - dividends[t];

      const totalAssets = fixedAssets + cash + debtors;
      const totalLiabilities = creditors + payrollCreditor + vatOwed + ctOwed
        + debtBalance[t] + openingOtherLiab;
      const netAssets = totalAssets - totalLiabilities;

      // P&L
      emit(t, 'pnl.revenue_total',  'Sales', revenue[t]);
      emit(t, 'pnl.cost_of_sales',  'Cost of sales', -cos[t]);
      emit(t, 'pnl.gross_profit',   'Gross profit', grossProfit[t]);
      emit(t, 'pnl.cost_payroll',   'Payroll', -payroll[t]);
      emit(t, 'pnl.cost_overheads', 'Overheads', -overheads[t]);
      emit(t, 'pnl.cost_total',     'Total costs', -costTotal[t]);
      emit(t, 'pnl.vat_frs_benefit','VAT flat-rate benefit', frsBenefit[t]);
      emit(t, 'pnl.ebitda',         'EBITDA', ebitda[t]);
      emit(t, 'pnl.interest_total', 'Interest', -interest[t]);
      emit(t, 'pnl.pbt',            'Profit before tax', pbt[t]);
      emit(t, 'pnl.tax_total',      'Corporation Tax', -ctCharge[t]);
      emit(t, 'pnl.npat',           'Profit after tax', npat[t]);
      emit(t, 'pnl.dividends',      'Dividends', -dividends[t]);

      // Cash
      emit(t, 'cf.opening_cash',      'Opening bank', opening);
      emit(t, 'cf.in.receipts',       'Receipts from customers', receipts[t] + openingDebtorReceipts[t]);
      emit(t, 'cf.in.vat_refund',     'VAT refund', vatRefund[t]);
      emit(t, 'cf.in.debt_drawdown',  'Loan drawdown', drawdown[t]);
      emit(t, 'cf.in_total',          'Total cash in', cashIn);
      emit(t, 'cf.out.cost_of_sales', 'Payments to suppliers', -(payCos[t] + openingCreditorPayments[t]));
      emit(t, 'cf.out.payroll',       'Net wages', -netWages[t]);
      emit(t, 'cf.out.paye',          'PAYE / NI / pension', -payeCash[t]);
      emit(t, 'cf.out.overheads',     'Overheads paid', -payOverheads[t]);
      emit(t, 'cf.out.vat',           'VAT paid', -vatPayment[t]);
      emit(t, 'cf.out.corp_tax',      'Corporation Tax paid', -ctPayment[t]);
      emit(t, 'cf.out.capex',         'Capital spend', -payCapex[t]);
      emit(t, 'cf.out.interest',      'Loan interest', -interest[t]);
      emit(t, 'cf.out.debt_principal','Loan repayments', -principal[t]);
      emit(t, 'cf.out.dividends',     'Dividends / drawings', -dividends[t]);
      emit(t, 'cf.out_total',         'Total cash out', -cashOut);
      emit(t, 'cf.net_movement',      'Net cash movement', cashIn - cashOut);
      emit(t, 'cf.closing_cash',      'Closing bank', cash);

      // Balance sheet. Liabilities are POSITIVE magnitudes here, matching the
      // childcare pack's convention (financial_core) so shared components —
      // the ratios panel, drill-downs — read both packs identically.
      emit(t, 'bs.fixed_assets',      'Fixed assets', fixedAssets);
      emit(t, 'bs.cash',              'Cash', cash);
      emit(t, 'bs.debtors',           'Debtors', debtors);
      emit(t, 'bs.current_assets',    'Total current assets', cash + debtors);
      emit(t, 'bs.total_assets',      'Total assets', totalAssets);
      emit(t, 'bs.creditors',         'Trade creditors', creditors);
      emit(t, 'bs.payroll_creditor',  'Payroll taxes owed', payrollCreditor);
      emit(t, 'bs.vat_liability',     'VAT owed', vatOwed);
      emit(t, 'bs.tax_liability',     'Company tax owed', ctOwed);
      emit(t, 'bs.loans',             'Loans outstanding', debtBalance[t]);
      emit(t, 'bs.other_liabilities', 'Other liabilities', openingOtherLiab);
      emit(t, 'bs.total_liabilities', 'Total liabilities', totalLiabilities);
      // Aliases the shared balance-sheet ratios panel reads. Loans sit in
      // non-current; everything else settles within the year.
      emit(t, 'bs.current_liabilities', 'Total current liabilities',
        creditors + payrollCreditor + vatOwed + ctOwed + openingOtherLiab);
      emit(t, 'bs.non_current_liabilities', 'Total non-current liabilities', debtBalance[t]);
      emit(t, 'bs.debt',              'Total debt', debtBalance[t]);
      emit(t, 'bs.net_assets',        'Net assets', netAssets);
      emit(t, 'bs.equity',            'Equity', equity);
      // Zero unless something has gone wrong — surfaced as a finding, and on
      // the statement itself, because a balance sheet that silently doesn't
      // balance is worse than no balance sheet.
      emit(t, 'bs.check',             'Balance check (should be nil)', netAssets - equity);

      emit(t, 'metric.vat_liability', 'VAT owed', vatOwed);
      emit(t, 'metric.ct_liability',  'CT owed', ctOwed);
      emit(t, 'metric.debtors',       'Money owed to us', debtors);
      emit(t, 'metric.creditors',     'Money we owe', creditors);
    }

    // Per-line cash movements, tagged so the cashflow statement can show the
    // same lines the user edits rather than four opaque totals.
    for (const entry of byLine.values()) {
      for (let t = 0; t < T; t++) {
        if (!entry.cash[t]) continue;
        emit(t, 'cf.line', entry.label, entry.cash[t],
          { line_id: entry.id, category: entry.category });
      }
    }

    return out;
  },

  validate(ctx) {
    const findings = [];
    const cash = ctx.upstreamOutputs.filter(o => o.nominal_type === 'cf.closing_cash');
    const low = cash.filter(o => o.amount_p < 0).sort((a, b) => a.period - b.period);
    if (low.length > 0) {
      const worst = cash.reduce((a, b) => (b.amount_p < a.amount_p ? b : a), cash[0]);
      findings.push({
        severity: 'error',
        code: 'cash.goes_negative',
        period: low[0].period,
        message: `Bank balance goes negative in month ${low[0].period + 1} and bottoms out at ${formatMoney(worst.amount_p, ctx.forecast?.currency)} in month ${worst.period + 1}.`,
      });
    }

    // The balance sheet is built so that it ties by construction; if it ever
    // doesn't, that is a modelling bug and must be loud, not silent.
    const checks = ctx.upstreamOutputs.filter(o => o.nominal_type === 'bs.check');
    const worstCheck = checks.reduce((a, b) => (Math.abs(b.amount_p) > Math.abs(a?.amount_p ?? 0) ? b : a), null);
    if (worstCheck && Math.abs(worstCheck.amount_p) > 100) {     // > £1, i.e. beyond rounding
      findings.push({
        severity: 'error',
        code: 'bs.does_not_balance',
        period: worstCheck.period,
        message: `Balance sheet is out by ${formatMoney(worstCheck.amount_p, ctx.forecast?.currency)} in month ${worstCheck.period + 1} — assets less liabilities do not equal equity.`,
      });
    }

    const payeShare = Number(ctx.resolve('payroll.paye_share_pct', {})) || 0;
    if (payeShare >= 60) {
      findings.push({
        severity: 'warn',
        code: 'payroll.paye_share_high',
        message: `PAYE/NI/pension is set to ${payeShare}% of payroll cost — that is high; the usual range is 20-35%.`,
      });
    }

    return findings;
  },
};
