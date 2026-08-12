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

const DAYS_PER_MONTH = 30.44;

export const generalCoreModule = {
  key: 'general_core',
  pack: ['general_cashflow'],
  dependsOn: ['pl_lines', 'loans'],
  drivers: [
    // ─── Opening position ───
    { key: 'cash.opening_balance_p', label: 'Opening bank balance', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },

    // ─── Working capital ───
    { key: 'wc.debtor_days',   label: 'Debtor days (customers pay in)', unit: 'days', kind: 'scalar', scope: 'group', defaultValue: 30 },
    { key: 'wc.creditor_days', label: 'Creditor days (we pay suppliers in)', unit: 'days', kind: 'scalar', scope: 'group', defaultValue: 30 },

    // ─── Payroll ───
    { key: 'payroll.paye_share_pct', label: 'PAYE/NI/pension as % of payroll cost (paid a month in arrears)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 30 },

    // ─── VAT ───
    { key: 'vat.registered',    label: 'VAT registered (1 = yes, 0 = no)', unit: 'flag', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'vat.rate_pct',      label: 'Standard VAT rate %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 20 },
    { key: 'vat.flat_rate_pct', label: 'Flat Rate Scheme % (0 = standard scheme)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'vat.stagger',       label: 'VAT quarter stagger (1 = Jan/Apr/Jul/Oct, 2 = Feb/May/Aug/Nov, 3 = Mar/Jun/Sep/Dec)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'vat.payment_lag_months', label: 'Months after quarter end that VAT is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'vat.opening_liability_p', label: 'VAT owed at the start', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'vat.opening_due_month',   label: 'Month the opening VAT is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },

    // ─── Corporation Tax ───
    { key: 'tax.ct_rate_pct',           label: 'Corporation Tax rate %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 25 },
    { key: 'tax.year_end_month',        label: 'Accounting year-end month (1-12)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'tax.ct_payment_lag_months', label: 'Months after year end that CT is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 9 },
    { key: 'tax.ct_opening_liability_p', label: 'CT owed at the start', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 0 },
    { key: 'tax.ct_opening_due_month',   label: 'Month the opening CT is paid', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },

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

    { nominal_type: 'bs.cash',              label: 'Cash', by_entity: false },
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

      if (cat === 'income') {
        revenue[t] += amt;
        const vat = vatable ? amt * vatRate : 0;
        outputVat[t] += vat;
        spread(receipts, t, amt + vat, lineLag == null ? debtorDays : lineLag);
      } else if (cat === 'payroll') {
        // No VAT on wages, and the cash split is the PAYE timing below.
        payroll[t] += amt;
      } else {
        const vat = vatable ? amt * vatRate : 0;
        // Under the Flat Rate Scheme input VAT is not reclaimable (the
        // capital-goods exception above £2,000 is not modelled).
        if (!onFrs) inputVat[t] += vat;
        const lag = lineLag == null ? creditorDays : lineLag;
        if (cat === 'cost_of_sales') { cos[t] += amt; spread(payCos, t, amt + vat, lag); }
        else if (cat === 'capex')    { capex[t] += amt; spread(payCapex, t, amt + vat, lag); }
        else                         { overheads[t] += amt; spread(payOverheads, t, amt + vat, lag); }
      }
    }

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
    const grossProfit = zeros(), costTotal = zeros(), ebitda = zeros(), pbt = zeros();
    const ctCharge = zeros(), npat = zeros();
    let lossCarryforward = 0;
    for (let t = 0; t < T; t++) {
      grossProfit[t] = revenue[t] - cos[t];
      costTotal[t] = cos[t] + payroll[t] + overheads[t];
      ebitda[t] = revenue[t] - costTotal[t];
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

    // ── Corporation Tax payments ────────────────────────────────────
    // Each accounting year's charge settles `ctLag` months after the year end.
    const ctPayment = zeros();
    let ctBucket = 0;
    for (let t = 0; t < T; t++) {
      ctBucket += ctCharge[t];
      if (monthOf(t) === yearEndMonth) {
        const payAt = t + ctLag;
        if (payAt >= 0 && payAt < T) ctPayment[payAt] += ctBucket;
        ctBucket = 0;
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
    let debtors = 0, creditors = 0;

    const emit = (t, nominal_type, line_label, amount_p, tags) => {
      out.push({ module_key: 'general_core', period: t, nominal_type, line_label,
        amount_p: Math.round(amount_p), ...(tags ? { tags } : {}) });
    };

    for (let t = 0; t < T; t++) {
      const cashIn = receipts[t] + vatRefund[t] + drawdown[t];
      const cashOut = payCos[t] + netWages[t] + payeCash[t] + payOverheads[t]
        + vatPayment[t] + ctPayment[t] + payCapex[t] + interest[t] + principal[t] + dividends[t];
      const opening = cash;
      cash = opening + cashIn - cashOut;

      // Running balances — what is owed to and by the company at month end.
      const grossSales = revenue[t] + outputVat[t];
      const grossCosts = cos[t] + overheads[t] + capex[t] + (onFrs ? 0 : inputVat[t]);
      debtors += grossSales - receipts[t];
      creditors += grossCosts - (payCos[t] + payOverheads[t] + payCapex[t]);
      vatOwed += vatAccrual[t] - vatPayment[t] + vatRefund[t];
      ctOwed += ctCharge[t] - ctPayment[t];

      // P&L
      emit(t, 'pnl.revenue_total',  'Sales', revenue[t]);
      emit(t, 'pnl.cost_of_sales',  'Cost of sales', -cos[t]);
      emit(t, 'pnl.gross_profit',   'Gross profit', grossProfit[t]);
      emit(t, 'pnl.cost_payroll',   'Payroll', -payroll[t]);
      emit(t, 'pnl.cost_overheads', 'Overheads', -overheads[t]);
      emit(t, 'pnl.cost_total',     'Total costs', -costTotal[t]);
      emit(t, 'pnl.ebitda',         'EBITDA', ebitda[t]);
      emit(t, 'pnl.interest_total', 'Interest', -interest[t]);
      emit(t, 'pnl.pbt',            'Profit before tax', pbt[t]);
      emit(t, 'pnl.tax_total',      'Corporation Tax', -ctCharge[t]);
      emit(t, 'pnl.npat',           'Profit after tax', npat[t]);
      emit(t, 'pnl.dividends',      'Dividends', -dividends[t]);

      // Cash
      emit(t, 'cf.opening_cash',      'Opening bank', opening);
      emit(t, 'cf.in.receipts',       'Receipts from customers', receipts[t]);
      emit(t, 'cf.in.vat_refund',     'VAT refund', vatRefund[t]);
      emit(t, 'cf.in.debt_drawdown',  'Loan drawdown', drawdown[t]);
      emit(t, 'cf.in_total',          'Total cash in', cashIn);
      emit(t, 'cf.out.cost_of_sales', 'Payments to suppliers', -payCos[t]);
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

      emit(t, 'bs.cash',              'Cash', cash);
      emit(t, 'metric.vat_liability', 'VAT owed', vatOwed);
      emit(t, 'metric.ct_liability',  'CT owed', ctOwed);
      emit(t, 'metric.debtors',       'Money owed to us', debtors);
      emit(t, 'metric.creditors',     'Money we owe', creditors);
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
        message: `Bank balance goes negative in month ${low[0].period + 1} and bottoms out at £${(worst.amount_p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })} in month ${worst.period + 1}.`,
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
