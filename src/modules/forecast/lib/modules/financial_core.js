// Financial core — assembles P&L, BS, Cashflow.
//
// Reads upstream outputs and emits derived rows tagged for dashboard
// consumption. Specifically:
//   p&l.revenue_total, p&l.gross_profit, p&l.ebitda, p&l.ebit,
//   p&l.pbt, p&l.npat
//   bs.fixed_assets_net, bs.cash, bs.debt, bs.equity, bs.net_wc
//   cashflow.in, cashflow.out, cashflow.closing
//
// Reconciliation indicator: at every period, BS must balance and
// cash movement on the cashflow must equal cash delta on the BS. We
// emit findings with severity='error' if either fails by >£1 —
// collapsed into one finding per check with a period range and a
// root-cause hint, not one row per month.
//
// Opening balance sheet: the only opening position is cash. Opening
// equity is DERIVED (= opening cash) so the BS starts balanced by
// construction — the two can never be edited apart. Fund additional
// opening cash with an fc_loan starting month 0 (drawdown adds cash and
// a matching liability); opening fixed assets arrive via premises /
// fixed-asset capex flows. The old `bs.opening_equity_p` driver is
// retired and ignored (a deprecation finding fires if a legacy row
// still holds a different value).
//
// Drivers (group):
//   bs.opening_cash_p

export const financialCoreModule = {
  key: 'financial_core',
  pack: ['childcare_scotland', 'accountancy'],
  dependsOn: ['services_childcare', 'staff', 'overheads', 'premises', 'pre_opening', 'loans', 'working_capital', 'tax_simple'],

  drivers: [
    { key: 'bs.opening_cash_p', label: 'Opening cash (= capital introduced)', unit: 'gbp_p', kind: 'scalar', scope: 'group', defaultValue: 50000000 },
    // Inflation: applied annually as a multiplier on revenue / costs.
    // Compounded by elapsed years from forecast start.
    { key: 'inflation.income_pct', label: 'Income inflation (annual %)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 3 },
    { key: 'inflation.cost_pct',   label: 'Cost inflation (annual %)',   unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 4 },
    // Dividends: paid at year-end (every 12 months from start) as a % of YTD NPAT.
    { key: 'dividends.payout_ratio_pct', label: 'Dividend payout ratio (%)', unit: 'pct', kind: 'scalar', scope: 'group', defaultValue: 0 },
  ],

  outputs: [
    // P&L summary lines
    { nominal_type: 'pnl.revenue_total', label: 'Revenue', by_entity: false },
    { nominal_type: 'pnl.revenue_private', label: 'Revenue — private', by_entity: false },
    { nominal_type: 'pnl.revenue_la_funded', label: 'Revenue — LA funded', by_entity: false },
    { nominal_type: 'pnl.income_inflation_uplift', label: 'Income inflation uplift', by_entity: false },
    { nominal_type: 'pnl.cost_total', label: 'Operating costs', by_entity: false },
    { nominal_type: 'pnl.cost_inflation_uplift', label: 'Cost inflation uplift', by_entity: false },
    { nominal_type: 'pnl.ebitda', label: 'EBITDA', by_entity: false },
    { nominal_type: 'pnl.depreciation_total', label: 'Depreciation', by_entity: false },
    { nominal_type: 'pnl.ebit', label: 'EBIT', by_entity: false },
    { nominal_type: 'pnl.interest_total', label: 'Interest', by_entity: false },
    { nominal_type: 'pnl.pbt', label: 'PBT', by_entity: false },
    { nominal_type: 'pnl.tax_total', label: 'Tax', by_entity: false },
    { nominal_type: 'pnl.cost_staff_direct', label: 'Direct staff (site)', by_entity: false },
    { nominal_type: 'pnl.cost_direct_costs', label: 'Direct costs (consumables/food)', by_entity: false },
    { nominal_type: 'pnl.cost_staff_overhead', label: 'Overhead staff', by_entity: false },
    { nominal_type: 'pnl.cost_premises', label: 'Premises', by_entity: false },
    { nominal_type: 'pnl.cost_utilities', label: 'Utilities', by_entity: false },
    { nominal_type: 'pnl.cost_other_overhead', label: 'Other overheads', by_entity: false },
    { nominal_type: 'pnl.cost_admin', label: 'Admin (central)', by_entity: false },
    { nominal_type: 'pnl.cost_pre_opening', label: 'Pre-opening costs', by_entity: false },
    { nominal_type: 'pnl.npat', label: 'NPAT', by_entity: false },
    { nominal_type: 'pnl.dividends', label: 'Dividends declared', by_entity: false },
    { nominal_type: 'metric.headcount_total', label: 'Headcount total', by_entity: false },
    { nominal_type: 'metric.headcount_practitioners', label: 'Headcount practitioners', by_entity: false },
    { nominal_type: 'metric.headcount_managers', label: 'Headcount managers', by_entity: false },
    { nominal_type: 'metric.sqft_total', label: 'Square footage (active locations)', by_entity: false },
    { nominal_type: 'metric.sqft_leased', label: 'Square footage (leased only)', by_entity: false },
    { nominal_type: 'metric.locations_active', label: 'Active locations', by_entity: false },
    // Balance-sheet derived
    { nominal_type: 'bs.net_current_assets', label: 'Net current assets / (liabilities)', by_entity: false },
    { nominal_type: 'bs.net_assets', label: 'Net assets / (liabilities)', by_entity: false },

    // BS lines
    // Non-current assets
    { nominal_type: 'bs.fixed_assets_gross', label: 'Fixed assets (gross)', by_entity: false },
    { nominal_type: 'bs.accumulated_depreciation', label: 'Accumulated depreciation', by_entity: false },
    { nominal_type: 'bs.fixed_assets_net', label: 'Fixed assets (net)', by_entity: false },
    { nominal_type: 'bs.non_current_assets', label: 'Total non-current assets', by_entity: false },

    // Current assets
    { nominal_type: 'bs.cash', label: 'Cash', by_entity: false },
    { nominal_type: 'bs.debtors_private', label: 'Debtors — private', by_entity: false },
    { nominal_type: 'bs.debtors_la', label: 'Debtors — LA funded', by_entity: false },
    { nominal_type: 'bs.current_assets', label: 'Total current assets', by_entity: false },

    { nominal_type: 'bs.total_assets', label: 'Total assets', by_entity: false },

    // Current liabilities
    { nominal_type: 'bs.creditors', label: 'Creditors', by_entity: false },
    { nominal_type: 'bs.deposits_held', label: 'Parent deposits', by_entity: false },
    { nominal_type: 'bs.advance_billing', label: 'Advance billing', by_entity: false },
    { nominal_type: 'bs.tax_payable', label: 'Tax payable', by_entity: false },
    { nominal_type: 'bs.debt_current_portion', label: 'Debt — current portion', by_entity: false },
    { nominal_type: 'bs.current_liabilities', label: 'Total current liabilities', by_entity: false },

    // Long-term liabilities
    { nominal_type: 'bs.long_term_loans', label: 'Long-term loans (bank + mortgage)', by_entity: false },
    { nominal_type: 'bs.directors_loans', label: 'Directors\' loans', by_entity: false },
    { nominal_type: 'bs.non_current_liabilities', label: 'Total non-current liabilities', by_entity: false },

    // Legacy aggregate (kept for back-compat)
    { nominal_type: 'bs.net_wc', label: 'Net working capital (legacy)', by_entity: false },
    { nominal_type: 'bs.debt', label: 'Total debt (legacy)', by_entity: false },

    { nominal_type: 'bs.equity', label: 'Equity', by_entity: false },
    { nominal_type: 'bs.total_liab_equity', label: 'Total liabilities + equity', by_entity: false },

    // Cashflow lines — direct method
    { nominal_type: 'cf.opening_cash', label: 'Opening cash', by_entity: false },
    { nominal_type: 'cf.in.private', label: 'Cash in — private fees', by_entity: false },
    { nominal_type: 'cf.in.la_funded', label: 'Cash in — LA funded', by_entity: false },
    { nominal_type: 'cf.in.debt_drawdown', label: 'Cash in — debt drawdown', by_entity: false },
    { nominal_type: 'cf.in_total', label: 'Total cash in', by_entity: false },
    { nominal_type: 'cf.out.staff', label: 'Cash out — staff', by_entity: false },
    { nominal_type: 'cf.out.premises', label: 'Cash out — premises', by_entity: false },
    { nominal_type: 'cf.out.utilities', label: 'Cash out — utilities', by_entity: false },
    { nominal_type: 'cf.out.other_overhead', label: 'Cash out — other overheads', by_entity: false },
    { nominal_type: 'cf.out.pre_opening', label: 'Cash out — pre-opening (all)', by_entity: false },
    { nominal_type: 'cf.out.pre_opening_overhead',  label: 'Cash out — pre-opening overhead',  by_entity: false },
    { nominal_type: 'cf.out.pre_opening_marketing', label: 'Cash out — pre-opening marketing', by_entity: false },
    { nominal_type: 'cf.out.pre_opening_staffing',  label: 'Cash out — pre-opening staffing',  by_entity: false },
    { nominal_type: 'cf.out.one_off_total',   label: 'Total one-off cash out',           by_entity: false },
    { nominal_type: 'cf.out.recurring_total', label: 'Total recurring cash out',         by_entity: false },
    { nominal_type: 'cf.out.fin_tax_total',   label: 'Total financing & tax cash out',   by_entity: false },
    { nominal_type: 'cf.out.capex', label: 'Cash out — capex', by_entity: false },
    { nominal_type: 'cf.out.interest', label: 'Cash out — interest', by_entity: false },
    { nominal_type: 'cf.out.principal', label: 'Cash out — mortgage principal', by_entity: false },
    { nominal_type: 'cf.out.tax', label: 'Cash out — tax', by_entity: false },
    { nominal_type: 'cf.out.dividends', label: 'Cash out — dividends', by_entity: false },
    { nominal_type: 'cf.out_total', label: 'Total cash out', by_entity: false },
    { nominal_type: 'cf.wc_movement', label: 'Working capital movement', by_entity: false },
    { nominal_type: 'cf.operating', label: 'Operating cashflow', by_entity: false },
    { nominal_type: 'cf.investing', label: 'Investing cashflow', by_entity: false },
    { nominal_type: 'cf.financing', label: 'Financing cashflow', by_entity: false },
    { nominal_type: 'cf.net_movement', label: 'Net cash movement', by_entity: false },
    { nominal_type: 'cf.closing_cash', label: 'Closing cash', by_entity: false },

    // DSCR
    { nominal_type: 'metric.dscr', label: 'DSCR (rolling 12m)', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    const upstream = ctx.upstreamOutputs;
    const periods = ctx.periods;

    const openingCash = ctx.resolve('bs.opening_cash_p', {}) || 0;
    // Opening equity is derived, not entered: cash is the only opening
    // position, so equity must equal it for the BS to start balanced.
    const openingEquity = openingCash;
    const taxLagMonths = ctx.resolve('tax.payment_lag_months', {}) || 9;
    const incomeInflation = (ctx.resolve('inflation.income_pct', {}) || 0) / 100;
    const costInflation  = (ctx.resolve('inflation.cost_pct', {}) || 0) / 100;
    const payoutRatio    = (ctx.resolve('dividends.payout_ratio_pct', {}) || 0) / 100;

    // Inflation factor at period t = (1 + rate)^(year_index)
    // year_index = floor(t / 12). So Y1 has factor 1.0, Y2 = (1+r), etc.
    const incomeFactor = (t) => Math.pow(1 + incomeInflation, Math.floor(t / 12));
    const costFactor   = (t) => Math.pow(1 + costInflation,   Math.floor(t / 12));

    // Aggregate by period.
    //   *_base values are the un-inflated upstream amounts.
    //   We compute inflated revenue / costs by applying the per-period factor.
    const pnl = periods.map(() => ({
      revenue: 0, revenue_base: 0,
      costs: 0,   costs_base: 0,
      dep: 0, interest: 0, tax: 0,
      capex: 0, debt_principal: 0, debt_balance: 0,
      // Debt split by kind (director vs bank). Bank includes property mortgage
      // (premises module emits with no loan_kind tag) AND ad-hoc bank loans
      // (loans module emits with loan_kind='bank').
      debt_balance_director: 0, debt_balance_bank: 0,
      debt_principal_director: 0, debt_principal_bank: 0,
      wc_movement: 0,
      // Cost buckets — MUTUALLY EXCLUSIVE so they sum to costs_base.
      // Used for both CF cash-out bucketing and P&L category breakdown.
      revenue_private_base: 0, revenue_funded_base: 0,
      // ─── Direct (site-level) ───
      cost_staff_direct_base: 0,    // site staff: setting/asst managers + practitioners + apprentices
      cost_direct_costs_base: 0,    // consumables / food
      // ─── Overhead ───
      cost_staff_overhead_base: 0,  // exec / senior manager / admin (group-level staff)
      cost_premises_base: 0,        // rent / NDR / maintenance / service charge
      cost_utilities_base: 0,       // utilities
      cost_admin_base: 0,           // central admin overhead line
      cost_other_overhead_base: 0,  // insurance / software / marketing / professional fees
      cost_pre_opening_base: 0,     // ALL pre-opening (staff + overhead) — kept for P&L line
      cost_pre_opening_overhead_base: 0,    // pre-opening monthly overhead (registration period)
      cost_pre_opening_marketing_base: 0,   // pre-opening marketing spike
      cost_pre_opening_staffing_base: 0,    // pre-opening staff hires
      // staff headcount (sum across role/band tags)
      headcount_total: 0, headcount_practitioners: 0, headcount_managers: 0,
      // Dividend tracking
      dividend: 0,
    }));

    for (const r of upstream) {
      const t = r.period;
      if (t == null || t < 0 || t >= pnl.length) continue;
      const p = pnl[t];
      switch (r.nominal_type) {
        case 'revenue':
          p.revenue_base += r.amount_p;
          if (r.tags?.revenue_kind === 'private')      p.revenue_private_base += r.amount_p;
          else if (r.tags?.revenue_kind === 'funded')  p.revenue_funded_base  += r.amount_p;
          else                                          p.revenue_private_base += r.amount_p;
          break;
        case 'staff_cost': {
          p.costs_base += r.amount_p;
          const role = r.tags?.role;
          // Direct (site-level) = setting + assistant managers + all
          // practitioner-tier roles. Overhead staff = executive / senior
          // manager / admin (group-level). Pre-opening stays in its own bucket.
          const isDirectStaff = role === 'setting_manager' || role === 'assistant_manager'
            || role === 'senior_qualified' || role === 'qualified' || role === 'apprentice'
            || role === 'practitioner';
          if (r.module_key === 'pre_opening') {
            p.cost_pre_opening_base += r.amount_p;
            p.cost_pre_opening_staffing_base += r.amount_p;
          } else if (isDirectStaff) {
            p.cost_staff_direct_base += r.amount_p;
          } else {
            // executive, senior_manager, admin, manager (legacy)
            p.cost_staff_overhead_base += r.amount_p;
          }
          // Headcount tracking
          const hc = Number(r.tags?.headcount) || 0;
          if (hc > 0 && r.module_key !== 'pre_opening') {
            p.headcount_total += hc;
            if (isDirectStaff) p.headcount_practitioners += hc;
            else p.headcount_managers += hc;
          }
          break;
        }
        case 'overhead': {
          p.costs_base += r.amount_p;
          const lbl = r.line_label || '';
          if (r.module_key === 'pre_opening' || /^Pre-opening/i.test(lbl)) {
            p.cost_pre_opening_base += r.amount_p;
            if (/marketing/i.test(lbl)) {
              p.cost_pre_opening_marketing_base += r.amount_p;
            } else {
              // "Pre-opening overhead" (registration / monthly overhead) — fallback
              p.cost_pre_opening_overhead_base += r.amount_p;
            }
          } else if (lbl === 'Rent' || lbl === 'Service charge' || lbl === 'NDR' || lbl === 'Maintenance') {
            p.cost_premises_base += r.amount_p;
          } else if (/utilit/i.test(lbl)) {
            p.cost_utilities_base += r.amount_p;
          } else if (/consumable|food/i.test(lbl)) {
            p.cost_direct_costs_base += r.amount_p;
          } else if (lbl === 'Central admin') {
            p.cost_admin_base += r.amount_p;
          } else {
            p.cost_other_overhead_base += r.amount_p;
          }
          break;
        }
        case 'cost_of_sales':     p.costs_base += r.amount_p; p.cost_other_overhead_base += r.amount_p; break;
        case 'depreciation':      p.dep += r.amount_p; break;
        case 'debt_interest':     p.interest += r.amount_p; break;
        case 'tax':               p.tax += r.amount_p; break;
        case 'capex':             p.capex += r.amount_p; break;
        case 'debt_principal': {
          p.debt_principal += r.amount_p;
          if (r.tags?.loan_kind === 'director') p.debt_principal_director += r.amount_p;
          else p.debt_principal_bank += r.amount_p;
          break;
        }
        case 'debt_balance': {
          p.debt_balance += r.amount_p;
          if (r.tags?.loan_kind === 'director') p.debt_balance_director += r.amount_p;
          else p.debt_balance_bank += r.amount_p;
          break;
        }
        case 'working_capital_movement': p.wc_movement += r.amount_p; break;
      }
    }

    // Apply inflation factors. revenue / costs become inflated;
    // we keep an "uplift" field for transparency in the P&L.
    for (let t = 0; t < pnl.length; t++) {
      const p = pnl[t];
      const fInc = incomeFactor(t);
      const fCost = costFactor(t);
      p.revenue_uplift = p.revenue_base * (fInc - 1);
      p.cost_uplift    = p.costs_base    * (fCost - 1);
      p.revenue = p.revenue_base + p.revenue_uplift;
      p.costs   = p.costs_base   + p.cost_uplift;
    }

    // Running BS state
    let cash = openingCash;
    let fixedAssetsGross = 0;
    let accumulatedDep = 0;
    let equity = openingEquity;
    let prevDebtBalance = 0;     // for drawdown detection
    let taxPayable = 0;
    let npatYtd = 0;             // resets at start of each forecast year

    for (const t of periods) {
      const p = pnl[t];
      const ebitda = p.revenue - p.costs;
      const ebit = ebitda - p.dep;
      const pbt = ebit - p.interest;
      const npat = pbt - p.tax;

      // Cashflow: direct method
      const taxPaidThisPeriod = (t - taxLagMonths >= 0) ? pnl[t - taxLagMonths].tax : 0;

      // Net financing = delta(debt_balance). Split into drawdown (+ve) and
      // principal repayment (-ve) for the user-facing direct CF.
      const debtDelta = p.debt_balance - prevDebtBalance;
      prevDebtBalance = p.debt_balance;
      const debtDrawdown = Math.max(0, debtDelta + p.debt_principal);   // gross new draw this period
      const debtRepay = p.debt_principal;                               // gross principal repaid

      // Inflate CF buckets the same way revenue/costs were inflated above.
      const fInc = incomeFactor(t);
      const fCost = costFactor(t);

      // Year-end dividend: at month %12==11, pay payoutRatio of YTD NPAT.
      // Reset YTD at start of each year.
      if (t % 12 === 0) npatYtd = 0;
      npatYtd += npat;
      const isYearEnd = (t % 12) === 11;
      const dividend = (isYearEnd && payoutRatio > 0 && npatYtd > 0)
        ? Math.round(npatYtd * payoutRatio) : 0;
      p.dividend = dividend;

      // Direct cash buckets (use inflated values for revenue/costs)
      const cashIn = {
        private: p.revenue_private_base * fInc,
        funded:  p.revenue_funded_base  * fInc,
        debtDrawdown,
      };
      // Buckets are mutually exclusive. CF "staff" combines direct (site-level)
      // and overhead (group-level) staff. CF "other_overhead" includes
      // admin and direct costs (consumables) since they're all operating cash.
      const cashOut = {
        staff:           (p.cost_staff_direct_base + p.cost_staff_overhead_base) * fCost,
        premises:        p.cost_premises_base * fCost,
        utilities:       p.cost_utilities_base * fCost,
        other_overhead:  (p.cost_other_overhead_base + p.cost_admin_base + p.cost_direct_costs_base) * fCost,
        // Pre-opening split into its three line items so the cashflow
        // statement can show one-off setup spend at line-item granularity.
        pre_opening_overhead:  p.cost_pre_opening_overhead_base  * fCost,
        pre_opening_marketing: p.cost_pre_opening_marketing_base * fCost,
        pre_opening_staffing:  p.cost_pre_opening_staffing_base  * fCost,
        capex:           p.capex,
        interest:        p.interest,
        principal:       debtRepay,
        tax:             taxPaidThisPeriod,
        dividends:       dividend,
      };
      const cashOutPreOpening = cashOut.pre_opening_overhead + cashOut.pre_opening_marketing + cashOut.pre_opening_staffing;
      const totalIn = cashIn.private + cashIn.funded + cashIn.debtDrawdown;
      const totalOut = cashOut.staff + cashOut.premises + cashOut.utilities
        + cashOut.other_overhead + cashOutPreOpening + cashOut.capex
        + cashOut.interest + cashOut.principal + cashOut.tax
        + cashOut.dividends;
      // Subtotals for the restructured CF statement
      const totalOneOff    = cashOutPreOpening + cashOut.capex;
      const totalRecurring = cashOut.staff + cashOut.premises + cashOut.utilities + cashOut.other_overhead;
      const totalFinTax    = cashOut.interest + cashOut.principal + cashOut.tax + cashOut.dividends;

      // WC movement (signed) reconciles accrual to cash. +ve = cash drag.
      const netMovement = totalIn - totalOut - p.wc_movement;
      const openingCashThisPeriod = cash;

      // Roll-forward (existing indirect aggregates retained for compatibility)
      const operating = p.revenue - p.costs - p.interest - taxPaidThisPeriod - p.wc_movement;
      const investing = -p.capex;
      const financing = debtDelta;

      cash += netMovement;
      fixedAssetsGross += p.capex;
      accumulatedDep += p.dep;
      const fixedAssetsNet = fixedAssetsGross - accumulatedDep;

      // Tax payable: accrue this period, settle the lagged accrual via cash
      taxPayable += p.tax - taxPaidThisPeriod;

      // Equity: prior + NPAT - dividends paid
      equity += npat - dividend;

      // Net working capital is the running balance (we computed deltas; rebuild from upstream balances)
      // Easier: pull from fc_output rows we just emitted in working_capital
      const netWcRow = upstream.find(r =>
        r.module_key === 'working_capital' && r.period === t && r.nominal_type === 'wc_balance.debtors_private'
      );
      // recompose net WC from balance rows
      let debtorsPriv = 0, debtorsLa = 0, creditors = 0, deposits = 0, advance = 0;
      for (const r of upstream) {
        if (r.period !== t) continue;
        if (r.nominal_type === 'wc_balance.debtors_private') debtorsPriv = r.amount_p;
        else if (r.nominal_type === 'wc_balance.debtors_la') debtorsLa = r.amount_p;
        else if (r.nominal_type === 'wc_balance.creditors') creditors = r.amount_p;
        else if (r.nominal_type === 'wc_balance.deposits_held') deposits = r.amount_p;
        else if (r.nominal_type === 'wc_balance.advance_billing') advance = r.amount_p;
      }
      const netWc = debtorsPriv + debtorsLa - creditors - deposits - advance;

      const debt = p.debt_balance;

      // P&L rows. revenue_total / cost_total are INFLATED totals; the
      // separate `*_inflation_uplift` rows are the delta vs un-inflated
      // base, for transparency.
      // Cost categories: each emitted as a separate negative row so the
      // P&L can sum a structured breakdown that ties to cost_total.
      const costStaffDirect   = p.cost_staff_direct_base   * fCost;
      const costDirectCosts   = p.cost_direct_costs_base   * fCost;
      const costStaffOverhead = p.cost_staff_overhead_base * fCost;
      const costPreOpening    = p.cost_pre_opening_base    * fCost;
      const costAdmin         = p.cost_admin_base          * fCost;
      const costPremises      = p.cost_premises_base       * fCost;
      const costUtilities     = p.cost_utilities_base      * fCost;
      const costOtherOH       = p.cost_other_overhead_base * fCost;

      out.push(...[
        ['pnl.revenue_total', 'Revenue', p.revenue],
        ['pnl.revenue_private',   'Private fees', p.revenue_private_base * fInc],
        ['pnl.revenue_la_funded', 'LA funded',    p.revenue_funded_base  * fInc],
        ['pnl.income_inflation_uplift', 'Income inflation uplift', p.revenue_uplift],
        // Direct costs (site-level)
        ['pnl.cost_staff_direct',     'Direct staff (site managers + practitioners)', -costStaffDirect],
        ['pnl.cost_direct_costs',     'Direct costs (consumables / food)', -costDirectCosts],
        // Overheads
        ['pnl.cost_staff_overhead',   'Overhead staff (executive / senior mgr / admin)', -costStaffOverhead],
        ['pnl.cost_premises',         'Premises (rent / NDR / maintenance)', -costPremises],
        ['pnl.cost_utilities',        'Utilities', -costUtilities],
        ['pnl.cost_other_overhead',   'Other overheads', -costOtherOH],
        ['pnl.cost_admin',            'Admin (central overhead)', -costAdmin],
        ['pnl.cost_pre_opening',      'Pre-opening costs', -costPreOpening],
        ['pnl.cost_total', 'Operating costs (total)', -p.costs],
        ['pnl.cost_inflation_uplift', 'Cost inflation uplift', -p.cost_uplift],
        ['pnl.ebitda', 'EBITDA', ebitda],
        ['pnl.depreciation_total', 'Depreciation', -p.dep],
        ['pnl.ebit', 'EBIT', ebit],
        ['pnl.interest_total', 'Interest', -p.interest],
        ['pnl.pbt', 'PBT', pbt],
        ['pnl.tax_total', 'Tax', -p.tax],
        ['pnl.npat', 'NPAT', npat],
        ['pnl.dividends', 'Dividends declared', -dividend],
        // Headcount metrics (raw head counts for the P&L KPI footer)
        ['metric.headcount_total',         'Headcount (total)', p.headcount_total],
        ['metric.headcount_practitioners', 'Headcount (practitioners)', p.headcount_practitioners],
        ['metric.headcount_managers',      'Headcount (managers)', p.headcount_managers],
      ].map(([nt, lbl, amt]) => ({ module_key: 'financial_core', period: t, nominal_type: nt, line_label: lbl, amount_p: Math.round(amt) })));

      // Current portion of debt = principal due in next 12 months.
      let currentPortion = 0;
      for (let k = t + 1; k <= t + 12 && k < pnl.length; k++) {
        currentPortion += pnl[k].debt_principal;
      }
      // Director loans treated as long-term unless the user models a short repayment;
      // the principal-due heuristic above already moves any short-term director
      // principal into current automatically via debt_principal totals.
      const directorsLoans = p.debt_balance_director;
      const longTermLoans = Math.max(0, p.debt_balance_bank - currentPortion);
      // If most/all bank principal repays within 12mo, currentPortion can exceed
      // bank balance; cap at bank balance and let any residue stay in current.
      const cappedCurrentPortion = Math.min(currentPortion, p.debt_balance_bank);

      const nonCurrentAssets = fixedAssetsNet;
      const currentAssets = cash + debtorsPriv + debtorsLa;
      const totalAssets = nonCurrentAssets + currentAssets;
      const currentLiabilities = creditors + deposits + advance + taxPayable + cappedCurrentPortion;
      const nonCurrentLiabilities = longTermLoans + directorsLoans;
      const totalLiabEquity = currentLiabilities + nonCurrentLiabilities + equity;
      const netCurrentAssets = currentAssets - currentLiabilities;
      const netAssets = totalAssets - currentLiabilities - nonCurrentLiabilities;   // == equity if BS ties

      // Square footage of locations active in this period (open + same month).
      let sqftActive = 0, sqftLeased = 0, locActive = 0;
      for (const e of (ctx.entities || [])) {
        const cfg = e.config || {};
        const opensAt = cfg.opening_month_offset ?? 0;
        if (t < opensAt) continue;
        locActive += 1;
        sqftActive += Number(cfg.sq_ft) || 0;
        if (cfg.lease_or_buy === 'lease') sqftLeased += Number(cfg.sq_ft) || 0;
      }
      out.push(
        { module_key: 'financial_core', period: t, nominal_type: 'metric.sqft_total', line_label: 'Square footage', amount_p: sqftActive },
        { module_key: 'financial_core', period: t, nominal_type: 'metric.sqft_leased', line_label: 'Square footage (leased)', amount_p: sqftLeased },
        { module_key: 'financial_core', period: t, nominal_type: 'metric.locations_active', line_label: 'Active locations', amount_p: locActive },
      );

      out.push(...[
        // Non-current assets
        ['bs.fixed_assets_gross', 'Fixed assets (gross)', fixedAssetsGross],
        ['bs.accumulated_depreciation', 'Accumulated depreciation', -accumulatedDep],
        ['bs.fixed_assets_net', 'Fixed assets (net)', fixedAssetsNet],
        ['bs.non_current_assets', 'Total non-current assets', nonCurrentAssets],
        // Current assets
        ['bs.cash', 'Cash', cash],
        ['bs.debtors_private', 'Debtors — private', debtorsPriv],
        ['bs.debtors_la', 'Debtors — LA funded', debtorsLa],
        ['bs.current_assets', 'Total current assets', currentAssets],
        ['bs.total_assets', 'Total assets', totalAssets],
        // Current liabilities
        ['bs.creditors', 'Creditors', creditors],
        ['bs.deposits_held', 'Parent deposits', deposits],
        ['bs.advance_billing', 'Advance billing', advance],
        ['bs.tax_payable', 'Tax payable', taxPayable],
        ['bs.debt_current_portion', 'Debt — current portion', cappedCurrentPortion],
        ['bs.current_liabilities', 'Total current liabilities', currentLiabilities],
        ['bs.net_current_assets', 'Net current assets / (liabilities)', netCurrentAssets],
        // Non-current liabilities
        ['bs.long_term_loans', 'Long-term loans', longTermLoans],
        ['bs.directors_loans', 'Directors\' loans', directorsLoans],
        ['bs.non_current_liabilities', 'Total non-current liabilities', nonCurrentLiabilities],
        ['bs.net_assets', 'Net assets', netAssets],
        // Equity
        ['bs.equity', 'Equity', equity],
        ['bs.total_liab_equity', 'Total liabilities + equity', totalLiabEquity],
        // Legacy aggregates (other code may still read these)
        ['bs.net_wc', 'Net working capital', netWc],
        ['bs.debt', 'Total debt', debt],
      ].map(([nt, lbl, amt]) => ({ module_key: 'financial_core', period: t, nominal_type: nt, line_label: lbl, amount_p: Math.round(amt) })));

      // Cashflow rows — direct method: opening, in (private/funded), out (by category), closing
      out.push(...[
        ['cf.opening_cash',     'Opening cash',         openingCashThisPeriod],
        ['cf.in.private',       'Private fees',         cashIn.private],
        ['cf.in.la_funded',     'LA funded',            cashIn.funded],
        ['cf.in.debt_drawdown', 'Debt drawdown',        cashIn.debtDrawdown],
        ['cf.in_total',         'Total cash in',        totalIn],
        // ── One-off cash out: capex + pre-opening line items ──────
        ['cf.out.capex',                 'Capex',                            -cashOut.capex],
        ['cf.out.pre_opening_overhead',  'Pre-opening — overhead',           -cashOut.pre_opening_overhead],
        ['cf.out.pre_opening_marketing', 'Pre-opening — marketing',          -cashOut.pre_opening_marketing],
        ['cf.out.pre_opening_staffing',  'Pre-opening — staffing',           -cashOut.pre_opening_staffing],
        ['cf.out.one_off_total',         'Total one-off',                    -totalOneOff],
        // ── Recurring operating cash out ───────────────────────────
        ['cf.out.staff',         'Staff costs',                              -cashOut.staff],
        ['cf.out.premises',      'Premises (rent / NDR / maintenance)',      -cashOut.premises],
        ['cf.out.utilities',     'Utilities',                                -cashOut.utilities],
        ['cf.out.other_overhead','Other overheads',                          -cashOut.other_overhead],
        ['cf.out.recurring_total','Total recurring',                          -totalRecurring],
        // ── Financing & tax ────────────────────────────────────────
        ['cf.out.interest',     'Interest',             -cashOut.interest],
        ['cf.out.principal',    'Mortgage / loan principal', -cashOut.principal],
        ['cf.out.tax',          'Tax paid',             -cashOut.tax],
        ['cf.out.dividends',    'Dividends paid',       -cashOut.dividends],
        ['cf.out.fin_tax_total','Total financing & tax',-totalFinTax],
        ['cf.out_total',        'Total cash out',       -totalOut],
        ['cf.wc_movement',      'Working capital movement', -p.wc_movement],
        // Aggregate pre-opening row kept for back-compat (other views still read it)
        ['cf.out.pre_opening',  'Pre-opening (all)',    -cashOutPreOpening],
        // Indirect aggregates retained for validation + back-compat
        ['cf.operating',        'Operating',            operating],
        ['cf.investing',        'Investing',            investing],
        ['cf.financing',        'Financing',            financing],
        ['cf.net_movement',     'Net movement',         netMovement],
        ['cf.closing_cash',     'Closing cash',         cash],
      ].map(([nt, lbl, amt]) => ({ module_key: 'financial_core', period: t, nominal_type: nt, line_label: lbl, amount_p: Math.round(amt) })));
    }

    // DSCR rolling 12-month: (EBITDA - tax) / debt service
    for (let t = 0; t < periods.length; t++) {
      const lo = Math.max(0, t - 11);
      let ebitda = 0, tax = 0, ds = 0;
      for (let i = lo; i <= t; i++) {
        const p = pnl[i];
        ebitda += p.revenue - p.costs;
        tax += p.tax;
        ds += p.interest + p.debt_principal;
      }
      const dscr = ds > 0 ? ((ebitda - tax) / ds) : 0;
      out.push({
        module_key: 'financial_core', period: t,
        nominal_type: 'metric.dscr', line_label: 'DSCR',
        amount_p: Math.round(dscr * 10000),  // *10000 to keep precision: read as /10000
      });
    }

    return out;
  },

  validate(ctx) {
    const findings = [];
    const upstream = ctx.upstreamOutputs;
    const periods = ctx.periods;
    const openingCash = ctx.resolve('bs.opening_cash_p', {}) || 0;

    // Legacy opening-equity driver: retired — equity is derived from
    // opening cash so the BS always starts balanced. Tell the user if a
    // leftover row still holds a different value they might expect to bite.
    const legacyEquity = ctx.resolve('bs.opening_equity_p', {}) || 0;
    if (legacyEquity > 0 && Math.abs(legacyEquity - openingCash) > 100) {
      findings.push({
        severity: 'info',
        code: 'bs.opening_equity_retired',
        message: `The old "Opening equity" driver (${fmtGbp(legacyEquity)}) is no longer used — opening equity is now derived from Opening cash (${fmtGbp(openingCash)}) so the balance sheet always starts balanced. To model extra opening funding, add a loan starting month 0 instead.`,
      });
    }

    // Index financial_core rows once: period -> { nominal_type: amount }
    const byPeriod = new Map();
    for (const r of upstream) {
      if (r.module_key !== 'financial_core') continue;
      let m = byPeriod.get(r.period);
      if (!m) byPeriod.set(r.period, (m = {}));
      m[r.nominal_type] = r.amount_p;
    }

    // BS balance check: assets = liabilities + equity
    // Assets = fixed_assets_net + net_wc + cash
    // L+E    = debt + equity + tax payable (deposits + advance billing
    //          already netted into net_wc)
    const bsBreaks = [];
    const cfBreaks = [];
    let prevCash = openingCash;
    for (const t of periods) {
      const m = byPeriod.get(t) || {};
      const assets = (m['bs.fixed_assets_net'] || 0) + (m['bs.net_wc'] || 0) + (m['bs.cash'] || 0);
      const le = (m['bs.debt'] || 0) + (m['bs.equity'] || 0) + (m['bs.tax_payable'] || 0);
      const diff = assets - le;
      if (Math.abs(diff) > 100) bsBreaks.push({ t, diff });

      // Cash movement on cashflow vs BS cash delta
      const cfMove = m['cf.net_movement'] || 0;
      const cashNow = m['bs.cash'] || 0;
      const cfDiff = (prevCash + cfMove) - cashNow;
      if (Math.abs(cfDiff) > 100) cfBreaks.push({ t, diff: cfDiff });
      prevCash = cashNow;
    }

    // One finding per check, not one per month. Diagnose the classic
    // signature: a diff that is constant from some month onward means a
    // one-off entry with no matching funding source at that month.
    if (bsBreaks.length > 0) {
      const first = bsBreaks[0];
      const worst = bsBreaks.reduce((a, b) => (Math.abs(b.diff) > Math.abs(a.diff) ? b : a));
      const isConstant = bsBreaks.every(b => Math.abs(b.diff - first.diff) <= 100)
        && bsBreaks.length === periods.filter(t => t >= first.t).length;
      let hint = '';
      if (isConstant && first.t === 0) {
        hint = ' The difference is constant from month 0, which means the opening balances don\'t tie — check Opening cash and any month-0 capital or loan entries.';
      } else if (isConstant) {
        hint = ` The difference is constant from month ${first.t}, which points to a one-off entry at that month with no matching funding source (a balance changed without a corresponding cash, loan or equity movement).`;
      }
      const side = worst.diff > 0 ? 'assets exceed liabilities + equity' : 'liabilities + equity exceed assets';
      findings.push({
        severity: 'error', period: first.t,
        code: 'recon.bs_imbalance',
        message: `Balance sheet does not balance in ${bsBreaks.length} of ${periods.length} months (${describePeriodRanges(bsBreaks.map(b => b.t))}). Worst at month ${worst.t}: ${side} by ${fmtGbp(Math.abs(worst.diff))}.${hint}`,
      });
    }

    if (cfBreaks.length > 0) {
      const first = cfBreaks[0];
      const worst = cfBreaks.reduce((a, b) => (Math.abs(b.diff) > Math.abs(a.diff) ? b : a));
      findings.push({
        severity: 'error', period: first.t,
        code: 'recon.cf_bs_mismatch',
        message: `Cashflow closing cash does not tie to balance-sheet cash in ${cfBreaks.length} of ${periods.length} months (${describePeriodRanges(cfBreaks.map(b => b.t))}). Worst at month ${worst.t}: off by ${fmtGbp(Math.abs(worst.diff))}. This is an engine inconsistency (a flow hit the P&L or BS without the matching cash line) — recompute, and if it persists report it as a bug.`,
      });
    }

    return findings;
  },
};

// £-format a pence amount for finding messages.
function fmtGbp(p) {
  return '£' + Math.round(p / 100).toLocaleString('en-GB');
}

// Collapse a sorted list of period indices into "months 0–11, 14, 20–59".
function describePeriodRanges(ts) {
  if (ts.length === 0) return '';
  const parts = [];
  let start = ts[0];
  let prev = ts[0];
  for (let i = 1; i <= ts.length; i++) {
    const v = ts[i];
    if (v === prev + 1) { prev = v; continue; }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = v;
  }
  return 'months ' + parts.join(', ');
}
