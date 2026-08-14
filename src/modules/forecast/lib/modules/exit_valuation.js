// Exit valuation — EBITDA × multiple, IRR, MOIC, football-field grid.
//
// Drivers:
//   exit.year                — int, years from forecast start (5..10)
//   exit.multiple            — EV/EBITDA multiple at exit
//   exit.ebitda_basis        — 'exit_year' | 'run_rate' | 'ltm'
//   exit.transaction_cost_pct— flat % of EV
//   exit.tax_rate_pct        — flat exit-gain tax (CGT-equivalent)
//
// Outputs (group, single period at exit_month):
//   deal.ebitda_at_exit
//   deal.enterprise_value
//   deal.net_debt_at_exit
//   deal.transaction_costs
//   deal.exit_tax
//   deal.equity_proceeds
//   deal.investor_irr_pct
//   deal.moic
//   deal.football_field      — flat row per (multiple_step, ebitda_step) in tags

import { irr } from '../numerics.js';
import { resolveOr } from '../drivers.js';

export const exitValuationModule = {
  key: 'exit_valuation',
  pack: ['childcare_scotland', 'accountancy'],
  dependsOn: ['financial_core'],

  drivers: [
    { key: 'exit.year', label: 'Exit year (from forecast start)', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 7 },
    { key: 'exit.multiple', label: 'EV/EBITDA multiple at exit', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 7 },
    { key: 'exit.ebitda_basis', label: 'EBITDA basis', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 0 },   // 0 = exit_year LTM, 1 = run-rate, 2 = exit-month annualised
    { key: 'exit.transaction_cost_pct', label: 'Transaction costs %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 2 },
    { key: 'exit.tax_rate_pct', label: 'Exit gain tax %', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 24 },
    // Football field — customisable multiples range. Childcare typically 1–6×.
    { key: 'exit.football_min_multiple', label: 'Football field — min multiple', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 1 },
    { key: 'exit.football_max_multiple', label: 'Football field — max multiple', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 6 },
    { key: 'exit.football_columns', label: 'Football field — number of columns', unit: 'count', kind: 'scalar', scope: 'group', defaultValue: 8 },
  ],

  outputs: [
    { nominal_type: 'deal.ebitda_at_exit',       label: 'EBITDA at exit', by_entity: false },
    { nominal_type: 'deal.enterprise_value',     label: 'Enterprise value', by_entity: false },
    { nominal_type: 'deal.net_debt_at_exit',     label: 'Net debt at exit', by_entity: false },
    { nominal_type: 'deal.transaction_costs',    label: 'Transaction costs', by_entity: false },
    { nominal_type: 'deal.exit_tax',             label: 'Exit tax', by_entity: false },
    { nominal_type: 'deal.equity_proceeds',      label: 'Equity proceeds (net)', by_entity: false },
    { nominal_type: 'deal.investor_irr_bps',     label: 'Investor IRR (bps)', by_entity: false },
    { nominal_type: 'deal.moic_x10000',          label: 'MOIC ×10000', by_entity: false },
    { nominal_type: 'deal.football_field',       label: 'Football field cell', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    // exit.year keeps the plain `|| 7`: year 0 is not an exit plan, it is an
    // empty box, and it would put exitMonth at -1 and emit the whole deal at
    // a period that doesn't exist.
    const exitYear = ctx.resolve('exit.year', {}) || 7;
    // A 0× multiple is a real (if bleak) input — the buyer pays nothing for
    // the earnings and you clear the debt out of the proceeds — so honour it.
    const multiple = resolveOr(ctx, 'exit.multiple', 7);
    const ebitdaBasis = Math.round(ctx.resolve('exit.ebitda_basis', {}) || 0);
    const txnPct = (ctx.resolve('exit.transaction_cost_pct', {}) || 0) / 100;
    const exitTaxPct = (ctx.resolve('exit.tax_rate_pct', {}) || 0) / 100;

    const exitMonth = Math.min(exitYear * 12 - 1, ctx.periods.length - 1);

    // Pull EBITDA series from upstream (financial_core emitted pnl.ebitda)
    const ebitdaByT = {};
    const debtByT = {};
    const cashByT = {};
    for (const r of ctx.upstreamOutputs) {
      if (r.module_key !== 'financial_core') continue;
      if (r.nominal_type === 'pnl.ebitda') ebitdaByT[r.period] = r.amount_p;
      else if (r.nominal_type === 'bs.debt') debtByT[r.period] = r.amount_p;
      else if (r.nominal_type === 'bs.cash') cashByT[r.period] = r.amount_p;
    }

    // EBITDA basis at exit
    let ebitdaAtExit = 0;
    if (ebitdaBasis === 0) {
      // LTM at exit_month
      let sum = 0;
      for (let i = Math.max(0, exitMonth - 11); i <= exitMonth; i++) sum += (ebitdaByT[i] || 0);
      ebitdaAtExit = sum;
    } else if (ebitdaBasis === 1) {
      // Run-rate: last 3 months annualised
      let sum = 0; let n = 0;
      for (let i = Math.max(0, exitMonth - 2); i <= exitMonth; i++) { sum += (ebitdaByT[i] || 0); n++; }
      ebitdaAtExit = n > 0 ? (sum / n) * 12 : 0;
    } else {
      // Exit month annualised
      ebitdaAtExit = (ebitdaByT[exitMonth] || 0) * 12;
    }

    const ev = ebitdaAtExit * multiple;
    const netDebt = (debtByT[exitMonth] || 0) - (cashByT[exitMonth] || 0);
    const txnCosts = ev * txnPct;
    const grossEquity = ev - netDebt - txnCosts;
    // Investor cost basis = total capital introduced = central pot +
    // per-location opening cash. financial_core emits one attribution
    // row per source at t=0 — sum them rather than re-resolving drivers.
    let openingEquity = 0;
    for (const r of ctx.upstreamOutputs) {
      if (r.nominal_type === 'bs.opening_cash_alloc' && r.period === 0) openingEquity += r.amount_p;
    }
    if (openingEquity === 0) openingEquity = ctx.resolve('bs.opening_cash_p', {}) || 0;
    const gain = Math.max(0, grossEquity - openingEquity);
    const exitTax = gain * exitTaxPct;
    const netEquity = grossEquity - exitTax;

    // Investor cashflow: (equity in at t=0) -> ... no dividends modelled v1 -> netEquity at exit
    // IRR over months, then convert to annual.
    const series = new Array(exitMonth + 1).fill(0);
    series[0] = -openingEquity;
    series[exitMonth] = netEquity;
    const monthlyIrr = irr(series);
    const annualIrr = monthlyIrr != null ? (Math.pow(1 + monthlyIrr, 12) - 1) : null;
    const moic = openingEquity > 0 ? (netEquity / openingEquity) : 0;

    // Emit at exit_month
    const push = (nt, lbl, amt) => out.push({
      module_key: 'exit_valuation', period: exitMonth,
      nominal_type: nt, line_label: lbl, amount_p: Math.round(amt),
    });
    push('deal.ebitda_at_exit', 'EBITDA at exit', ebitdaAtExit);
    push('deal.enterprise_value', 'Enterprise value', ev);
    push('deal.net_debt_at_exit', 'Net debt at exit', netDebt);
    push('deal.transaction_costs', 'Transaction costs', txnCosts);
    push('deal.exit_tax', 'Exit tax', exitTax);
    push('deal.equity_proceeds', 'Equity proceeds (net)', netEquity);
    push('deal.investor_irr_bps', 'Investor IRR (bps)', annualIrr != null ? annualIrr * 10000 : 0);
    push('deal.moic_x10000', 'MOIC ×10000', moic * 10000);

    // Football field: configurable column count between min and max multiples.
    // Either end of the range may legitimately be 0× — a football field that
    // starts at nothing is a fine way to show the downside. The column count
    // may not: it divides the range, and 0 columns is an unset box, not a
    // chart with no columns.
    const ffMin = resolveOr(ctx, 'exit.football_min_multiple', 1);
    const ffMax = resolveOr(ctx, 'exit.football_max_multiple', 6);
    const ffCols = Math.max(2, Math.round(ctx.resolve('exit.football_columns', {}) || 8));
    const step = ffCols > 1 ? (ffMax - ffMin) / (ffCols - 1) : 0;
    const multiples = [];
    for (let i = 0; i < ffCols; i++) multiples.push(ffMin + i * step);
    const ebitdaShifts = [0.7, 0.85, 1.0, 1.15, 1.3];
    for (const m of multiples) {
      for (const s of ebitdaShifts) {
        const e = ebitdaAtExit * s;
        const evCell = e * m;
        const equityCell = evCell - netDebt - evCell * txnPct;
        const taxCell = Math.max(0, equityCell - openingEquity) * exitTaxPct;
        const netCell = equityCell - taxCell;
        out.push({
          module_key: 'exit_valuation', period: exitMonth,
          nominal_type: 'deal.football_field', line_label: `${m.toFixed(2)}x × ${(s * 100).toFixed(0)}%`,
          amount_p: Math.round(netCell),
          tags: { multiple: m, ebitda_pct: s },
        });
      }
    }

    return out;
  },
};
