// UI-side statement aggregator.
//
// The engine (financial_core) emits group-level P&L/BS/CF lines by
// summing across all entities. To support location filtering at view
// time we need to RE-DERIVE those lines for an arbitrary subset of
// entities. This module does that by walking upstream module rows
// (revenue, staff_cost, overhead, depreciation, debt_interest, tax,
// capex, debt_principal, debt_balance, working_capital_movement,
// wc_balance.*) and rebuilding the totals on the fly.
//
// Inputs:
//   outputs       — fc_output rows (already loaded)
//   periods       — array of period indices to compute
//   entityIds     — Set of entity ids to include; null = all entities
//                   (group-level rows apportioned by revenue share — see below)
//   inflationPct  — 'derive' (recommended) reads the engine's own
//                   inflation-uplift rows so the scoped view inherits the
//                   scenario's inflation settings exactly; or
//                   { income, cost } in pct (e.g. 3 = 3%) for an override.
//                   With 'derive', year-end dividends also inherit the
//                   group's effective payout ratio.
//
//   openingCash   — 'derive' (recommended) starts the cash roll-forward
//                   from the capital ATTRIBUTED to the in-scope locations
//                   (per-entity `bs.opening_cash_alloc` rows emitted by
//                   financial_core). The central/unallocated pot counts
//                   only when unfiltered — copying it into every subset
//                   would double-count it across site views. Or a number
//                   for an explicit override. openingEquity: 'derive'
//                   mirrors the derived cash so the scoped BS starts
//                   balanced.
//
// GROUP-LEVEL rows (central staff, central admin overhead, group loans,
// working capital) are apportioned to a filtered view by REVENUE SHARE —
// the scope's slice of that period's total revenue — so site views carry
// a fair slice of shared costs and sum back to the group. Periods before
// any revenue exists borrow the nearest following period's share.
//
// Returns: a Map keyed by `${nominal_type}::${period}` -> amount_p.
//
// What's filterable:
//   - All P&L lines (recomputed)
//   - All CF lines except cf.opening_cash / cf.closing_cash, which
//     require running cash state; we re-derive them from a per-period
//     running sum applied to the filtered net movement.
//
// What's NOT filterable (always group-level):
//   - BS lines other than fixed_assets_net (per-entity stocks need
//     opening allocations we don't track per-entity yet).
//   - Exit valuation (group-level by definition).
//
// For un-filtered ("all") view, the caller can skip this module and
// read financial_core's pre-aggregated rows directly. This gives the
// same numbers but is faster and includes inflation+dividends.

import { isPremisesCost } from './timeline.js';

const REVENUE_NTS = ['revenue'];
const COST_NTS = ['staff_cost', 'overhead', 'cost_of_sales'];
const DEP_NTS = ['depreciation'];
const INT_NTS = ['debt_interest'];
const TAX_NTS = ['tax'];
const CAPEX_NTS = ['capex'];
const DEBT_PRIN_NTS = ['debt_principal'];
const DEBT_BAL_NTS = ['debt_balance'];
const WC_MVT_NTS = ['working_capital_movement'];

export function scopedAggregate({ outputs, periods, entityIds, inflationPct, openingCash, openingEquity, taxLagMonths, payoutRatioPct, entities = [] }) {
  const result = new Map();
  const set = (nt, t, v) => result.set(`${nt}::${t}`, Math.round(v));

  const inScope = (o) => {
    if (!entityIds) return true;
    if (o.entity_id == null) return true;   // group-level rows always count
    return entityIds.has(o.entity_id);
  };

  // Pre-bucket upstream rows by period.
  const byPeriod = new Map();
  for (const o of outputs) {
    const t = o.period;
    if (t == null) continue;
    if (!byPeriod.has(t)) byPeriod.set(t, []);
    byPeriod.get(t).push(o);
  }

  // Inflation factors. 'derive' back-solves the engine's own per-period
  // factors from its emitted uplift rows (uplift = base × (f − 1)), so
  // the scoped view inherits the scenario's inflation settings exactly —
  // no driver lookup needed and no drift if the engine's basis changes.
  const derive = inflationPct === 'derive';
  let incomeFactor, costFactor;
  if (derive) {
    ({ incomeFactor, costFactor } = deriveInflationFactors(outputs));
  } else {
    incomeFactor = (t) => Math.pow(1 + (inflationPct?.income || 0) / 100, Math.floor(t / 12));
    costFactor   = (t) => Math.pow(1 + (inflationPct?.cost   || 0) / 100, Math.floor(t / 12));
  }

  // Cost categorisation matching financial_core
  const isPremises  = isPremisesCost;   // shared with financial_core's bucketing
  const isUtilities = (lbl) => /utilit/i.test(lbl);
  const isPreOpening = (mod, lbl) => mod === 'pre_opening' || /^Pre-opening/i.test(lbl);

  // Opening cash: 'derive' sums the engine's attribution rows — per-entity
  // capital for in-scope locations, plus the central pot only when the
  // view is unfiltered (a shared pot copied into every subset would
  // double-count across site views).
  let cash0;
  if (openingCash === 'derive') {
    cash0 = 0;
    for (const r of byPeriod.get(0) || []) {
      if (r.nominal_type !== 'bs.opening_cash_alloc') continue;
      if (r.entity_id == null ? !entityIds : (!entityIds || entityIds.has(r.entity_id))) cash0 += r.amount_p;
    }
  } else {
    cash0 = openingCash || 0;
  }

  // Revenue-share per period — the fraction of shared (group-level) rows
  // a filtered view carries. Zero-revenue periods (pre-opening) borrow
  // the nearest following period's share so central costs aren't lost.
  const shareByT = revenueSharesByPeriod(outputs, periods, entityIds);

  // Running BS state for cash + equity + tax_payable
  let cash = cash0;
  let equity = openingEquity === 'derive' ? cash0 : (openingEquity || 0);
  let taxPayable = 0;
  let prevDebtBalance = 0;
  let npatYtd = 0;
  let fixedAssetsGross = 0;
  let accumulatedDep = 0;

  const taxLag = taxLagMonths ?? 9;
  const payout = (payoutRatioPct || 0) / 100;

  // We'll need per-period derived values
  const pnlByT = [];

  for (const t of periods) {
    const allRows = byPeriod.get(t) || [];
    const rows = allRows.filter(inScope);          // metrics only (whole headcounts)
    const share = entityIds ? (shareByT.get(t) ?? 1) : 1;
    // Entity rows in scope at full weight; group-level rows at the
    // scope's revenue share (so shared costs apportion, not duplicate).
    const sumScoped = (pred) => {
      let ent = 0, grp = 0;
      for (const r of allRows) {
        if (!pred(r)) continue;
        if (r.entity_id == null) grp += r.amount_p;
        else if (!entityIds || entityIds.has(r.entity_id)) ent += r.amount_p;
      }
      return ent + grp * share;
    };
    const fInc = incomeFactor(t);
    const fCost = costFactor(t);

    const revenuePrivBase = sumScoped(r => r.nominal_type === 'revenue' && r.tags?.revenue_kind !== 'funded');
    const revenueFundBase = sumScoped(r => r.nominal_type === 'revenue' && r.tags?.revenue_kind === 'funded');
    const revenueBase = revenuePrivBase + revenueFundBase;
    const revenueUplift = revenueBase * (fInc - 1);
    const revenue = revenueBase + revenueUplift;

    // Staff: split into site-level (direct) and group-level (overhead),
    // mirroring financial_core's bucketing so the on-screen P&L rows are
    // populated when the view is location-filtered.
    const DIRECT_ROLES = new Set(['setting_manager', 'assistant_manager',
      'senior_qualified', 'qualified', 'apprentice', 'practitioner', 'cook']);
    const isDirectStaff = (r) => r.nominal_type === 'staff_cost'
      && r.module_key !== 'pre_opening'
      && DIRECT_ROLES.has(r.tags?.role);
    const isOverheadStaff = (r) => r.nominal_type === 'staff_cost'
      && r.module_key !== 'pre_opening'
      && !DIRECT_ROLES.has(r.tags?.role);
    const staffDirectBase   = sumScoped(isDirectStaff);
    const staffOverheadBase = sumScoped(isOverheadStaff);
    const staffBase = staffDirectBase + staffOverheadBase;
    const preOpenStaffBase = sumScoped(r => r.nominal_type === 'staff_cost' && r.module_key === 'pre_opening');

    const premisesBase = sumScoped(r => r.nominal_type === 'overhead' && isPremises(r.line_label || ''));
    // Premises sub-lines — mirrors financial_core's split so the cashflow's
    // rent / service charge / maintenance / other rows survive a location
    // filter. These sum to premisesBase; never add them to a total.
    const premisesLine = (label) => sumScoped(r =>
      r.nominal_type === 'overhead' && (r.line_label || '') === label);
    const premisesRentBase    = premisesLine('Rent');
    const premisesSvcBase     = premisesLine('Service charge');
    const premisesMaintBase   = premisesLine('Maintenance');
    const premisesOtherBase   = premisesBase - premisesRentBase - premisesSvcBase - premisesMaintBase;
    const utilitiesBase = sumScoped(r => r.nominal_type === 'overhead' && isUtilities(r.line_label || ''));
    const preOpenOverheadBase = sumScoped(r => r.nominal_type === 'overhead' && isPreOpening(r.module_key, r.line_label || ''));
    // Pre-opening line-item split (overhead is the registration period catch-all,
    // marketing is the spike, staffing is the staff_cost rows)
    const preOpenMarketingBase = sumScoped(r =>
      r.nominal_type === 'overhead' && isPreOpening(r.module_key, r.line_label || '') && /marketing/i.test(r.line_label || '')
    );
    const preOpenOhRecurringBase = preOpenOverheadBase - preOpenMarketingBase;
    // Direct costs (consumables / food) carved out so the P&L row matches the engine.
    const directCostsBase = sumScoped(r =>
      r.nominal_type === 'overhead' && r.module_key !== 'pre_opening' && /consumable|food/i.test(r.line_label || '')
    );
    const adminBase = sumScoped(r =>
      r.nominal_type === 'overhead' && r.module_key !== 'pre_opening' && (r.line_label || '') === 'Central admin'
    );
    const otherOverheadBase = sumScoped(r =>
      (r.nominal_type === 'overhead' && !isPremises(r.line_label || '') && !isUtilities(r.line_label || '') && !isPreOpening(r.module_key, r.line_label || '') && !/consumable|food/i.test(r.line_label || '') && (r.line_label || '') !== 'Central admin')
      || r.nominal_type === 'cost_of_sales'
    );
    const preOpenBase = preOpenStaffBase + preOpenOverheadBase;
    const costsBase = staffBase + premisesBase + utilitiesBase + otherOverheadBase + directCostsBase + adminBase + preOpenBase;
    const costsUplift = costsBase * (fCost - 1);
    const costs = costsBase + costsUplift;

    const dep = sumScoped(r => DEP_NTS.includes(r.nominal_type));
    const interest = sumScoped(r => INT_NTS.includes(r.nominal_type));
    // Tax: when a location filter is active, the group-level `tax` row was
    // being pulled in wholesale — overstating the tax burden on a single
    // entity. Recompute scoped tax from scoped PBT × effective group tax
    // rate (= group_tax / group_PBT for periods with positive group PBT).
    // max(0, …) matches the engine's no-group-relief behaviour.
    const taxRaw = sumScoped(r => TAX_NTS.includes(r.nominal_type));
    let tax;
    if (entityIds) {
      // Derive effective rate from group-emitted rows for this period.
      let groupTax = 0, groupPbt = 0;
      for (const r of byPeriod.get(t) || []) {
        if (r.nominal_type === 'tax') groupTax += r.amount_p;
        else if (r.nominal_type === 'pnl.pbt' && !r.entity_id) groupPbt += r.amount_p;
      }
      // When the group pays no tax (losses still absorbing profits), the
      // marginal tax on the scope's profit is nil too — rate 0, not 25%.
      const effRate = groupPbt > 0 ? (groupTax / groupPbt) : 0;
      // Scoped PBT (signed) computed below; we need it now → reorder.
      const scopedPbt = (revenue - costs) - dep - interest;
      tax = Math.max(0, scopedPbt * effRate);
    } else {
      tax = taxRaw;
    }
    const capex = sumScoped(r => CAPEX_NTS.includes(r.nominal_type));
    const debtPrincipal = sumScoped(r => DEBT_PRIN_NTS.includes(r.nominal_type));
    const debtBalance = sumScoped(r => DEBT_BAL_NTS.includes(r.nominal_type));
    const wcMovement = sumScoped(r => WC_MVT_NTS.includes(r.nominal_type));

    const ebitda = revenue - costs;
    const ebit = ebitda - dep;
    const pbt = ebit - interest;
    const npat = pbt - tax;

    // Year-end dividends (group-level concept, applied to filtered NPAT
    // YTD). With 'derive', inherit the group's EFFECTIVE payout ratio
    // for the year (group dividends ÷ group NPAT YTD from emitted rows).
    if (t % 12 === 0) npatYtd = 0;
    npatYtd += npat;
    const isYearEnd = (t % 12) === 11;
    let dividend = 0;
    if (isYearEnd && npatYtd > 0) {
      let ratio = payout;
      if (derive) {
        let groupDiv = 0, groupNpatYtd = 0;
        for (let k = t - 11; k <= t; k++) {
          for (const r of byPeriod.get(k) || []) {
            if (r.nominal_type === 'pnl.dividends') groupDiv += -r.amount_p;    // emitted negative
            else if (r.nominal_type === 'pnl.npat' && !r.entity_id) groupNpatYtd += r.amount_p;
          }
        }
        ratio = groupNpatYtd > 0 ? Math.max(0, groupDiv / groupNpatYtd) : 0;
      }
      if (ratio > 0) dividend = Math.round(npatYtd * ratio);
    }

    // CF buckets — INFLATED for revenue/costs (matching financial_core)
    const cashIn_priv = revenuePrivBase * fInc;
    const cashIn_funded = revenueFundBase * fInc;

    const debtDelta = debtBalance - prevDebtBalance;
    prevDebtBalance = debtBalance;
    const debtDrawdown = Math.max(0, debtDelta + debtPrincipal);
    const debtRepay = debtPrincipal;

    const cashOut_staff     = staffBase * fCost;
    const cashOut_premises  = premisesBase * fCost;
    const cashOut_utilities = utilitiesBase * fCost;
    // Matches financial_core's CF bucketing: "other overhead" cash-out
    // carries admin + direct costs (consumables/food) too.
    const cashOut_otherOH   = (otherOverheadBase + adminBase + directCostsBase) * fCost;
    const cashOut_preOpenOh        = preOpenOhRecurringBase * fCost;
    const cashOut_preOpenMarketing = preOpenMarketingBase   * fCost;
    const cashOut_preOpenStaffing  = preOpenStaffBase       * fCost;
    const cashOut_preOpen   = cashOut_preOpenOh + cashOut_preOpenMarketing + cashOut_preOpenStaffing;
    const cashOut_capex     = capex;
    const cashOut_interest  = interest;
    const cashOut_principal = debtRepay;

    const taxPaidThisPeriod = (t - taxLag >= 0 && pnlByT[t - taxLag]) ? pnlByT[t - taxLag].tax : 0;
    const cashOut_tax = taxPaidThisPeriod;
    const cashOut_dividends = dividend;

    const totalIn = cashIn_priv + cashIn_funded + debtDrawdown;
    const totalOut = cashOut_staff + cashOut_premises + cashOut_utilities + cashOut_otherOH
      + cashOut_preOpen + cashOut_capex + cashOut_interest + cashOut_principal + cashOut_tax + cashOut_dividends;
    const netMovement = totalIn - totalOut - wcMovement;
    const openingCashThisPeriod = cash;
    cash += netMovement;

    fixedAssetsGross += capex;
    accumulatedDep += dep;
    const fixedAssetsNet = fixedAssetsGross - accumulatedDep;

    taxPayable += tax - taxPaidThisPeriod;
    equity += npat - dividend;

    pnlByT[t] = { tax, npat, ebitda };

    // Emit P&L
    set('pnl.revenue_total', t, revenue);
    set('pnl.revenue_private',   t, revenuePrivBase * fInc);
    set('pnl.revenue_la_funded', t, revenueFundBase * fInc);
    set('pnl.income_inflation_uplift', t, revenueUplift);
    // Per-category cost rows so the StatementView's line items populate
    // when a location filter is active. Each is signed -ve to match the
    // engine's convention and is inflation-loaded via fCost.
    set('pnl.cost_staff_direct',   t, -(staffDirectBase   * fCost));
    set('pnl.cost_direct_costs',   t, -(directCostsBase   * fCost));
    set('pnl.cost_staff_overhead', t, -(staffOverheadBase * fCost));
    set('pnl.cost_premises',       t, -(premisesBase      * fCost));
    set('pnl.cost_utilities',      t, -(utilitiesBase     * fCost));
    set('pnl.cost_other_overhead', t, -(otherOverheadBase * fCost));
    set('pnl.cost_admin',          t, -(adminBase         * fCost));
    set('pnl.cost_pre_opening',    t, -(preOpenBase       * fCost));
    set('pnl.cost_total', t, -costs);
    set('pnl.cost_inflation_uplift', t, -costsUplift);

    // ── Scoped metrics so the P&L KPI footer populates when filtering ──
    // Headcount: sum tags.headcount on in-scope staff_cost rows (exclude
    // pre-opening so it matches the engine's metric.headcount_total).
    let scopedHc = 0;
    for (const r of rows) {
      if (r.nominal_type !== 'staff_cost') continue;
      if (r.module_key === 'pre_opening') continue;
      scopedHc += Number(r.tags?.headcount) || 0;
    }
    set('metric.headcount_total', t, scopedHc);
    // Sq ft + active locations: from in-scope entities whose opening_month_offset ≤ t.
    let scopedSqft = 0, scopedSqftLeased = 0, scopedLocs = 0;
    for (const e of (entities || [])) {
      const cfg = e.config || {};
      const opn = cfg.opening_month_offset ?? 0;
      if (t < opn) continue;
      if (entityIds && !entityIds.has(e.id)) continue;
      scopedLocs += 1;
      const sf = Number(cfg.sq_ft) || 0;
      scopedSqft += sf;
      if (cfg.lease_or_buy === 'lease') scopedSqftLeased += sf;
    }
    set('metric.sqft_total', t, scopedSqft);
    set('metric.sqft_leased', t, scopedSqftLeased);
    set('metric.locations_active', t, scopedLocs);
    set('pnl.ebitda', t, ebitda);
    set('pnl.depreciation_total', t, -dep);
    set('pnl.ebit', t, ebit);
    set('pnl.interest_total', t, -interest);
    set('pnl.pbt', t, pbt);
    set('pnl.tax_total', t, -tax);
    set('pnl.npat', t, npat);
    set('pnl.dividends', t, -dividend);

    // CF
    set('cf.opening_cash', t, openingCashThisPeriod);
    set('cf.in.private', t, cashIn_priv);
    set('cf.in.la_funded', t, cashIn_funded);
    set('cf.in.debt_drawdown', t, debtDrawdown);
    set('cf.in_total', t, totalIn);
    // One-off section
    set('cf.out.capex', t, -cashOut_capex);
    set('cf.out.pre_opening_overhead',  t, -cashOut_preOpenOh);
    set('cf.out.pre_opening_marketing', t, -cashOut_preOpenMarketing);
    set('cf.out.pre_opening_staffing',  t, -cashOut_preOpenStaffing);
    set('cf.out.one_off_total', t, -(cashOut_capex + cashOut_preOpen));
    // Recurring section
    set('cf.out.staff', t, -cashOut_staff);
    set('cf.out.premises', t, -cashOut_premises);
    set('cf.out.premises_rent',           t, -(premisesRentBase  * fCost));
    set('cf.out.premises_service_charge', t, -(premisesSvcBase   * fCost));
    set('cf.out.premises_maintenance',    t, -(premisesMaintBase * fCost));
    set('cf.out.premises_other',          t, -(premisesOtherBase * fCost));
    set('cf.out.utilities', t, -cashOut_utilities);
    set('cf.out.other_overhead', t, -cashOut_otherOH);
    set('cf.out.recurring_total', t, -(cashOut_staff + cashOut_premises + cashOut_utilities + cashOut_otherOH));
    // Financing & tax
    set('cf.out.interest', t, -cashOut_interest);
    set('cf.out.principal', t, -cashOut_principal);
    set('cf.out.tax', t, -cashOut_tax);
    set('cf.out.dividends', t, -cashOut_dividends);
    set('cf.out.fin_tax_total', t, -(cashOut_interest + cashOut_principal + cashOut_tax + cashOut_dividends));
    // Aggregates / back-compat
    set('cf.out.pre_opening', t, -cashOut_preOpen);
    set('cf.out_total', t, -totalOut);
    set('cf.wc_movement', t, -wcMovement);
    set('cf.net_movement', t, netMovement);
    set('cf.closing_cash', t, cash);

    // BS — partial. Cash and FA are roll-forward; debt is upstream stock; equity is roll-forward.
    set('bs.fixed_assets_gross', t, fixedAssetsGross);
    set('bs.accumulated_depreciation', t, -accumulatedDep);
    set('bs.fixed_assets_net', t, fixedAssetsNet);
    set('bs.cash', t, cash);
    set('bs.debt', t, debtBalance);
    set('bs.equity', t, equity);
    set('bs.tax_payable', t, taxPayable);
    // Net WC: re-derived from upstream balance rows (group-level — takes
    // the scope's revenue share, matching the wc_movement treatment).
    const netWc = sumScoped(r => r.nominal_type === 'wc_balance.debtors_private')
      + sumScoped(r => r.nominal_type === 'wc_balance.debtors_la')
      - sumScoped(r => r.nominal_type === 'wc_balance.creditors')
      - sumScoped(r => r.nominal_type === 'wc_balance.deposits_held')
      - sumScoped(r => r.nominal_type === 'wc_balance.advance_billing');
    set('bs.net_wc', t, netWc);
  }

  return result;
}

/**
 * Convenience: returns a function compatible with StatementView's
 * `outputs` shape (array of {nominal_type, period, amount_p}) so we can
 * pass scoped aggregates into the existing view code.
 */
/**
 * Back-solve the engine's per-period inflation factors from its emitted
 * uplift rows (uplift = base × (f − 1)). Shared by scopedAggregate and
 * the PDF exporter so every scoped surface uses identical factors.
 */
export function deriveInflationFactors(outputs) {
  const baseRev = new Map(), upliftRev = new Map(), baseCost = new Map(), upliftCost = new Map();
  const bump = (m, t, v) => m.set(t, (m.get(t) || 0) + v);
  for (const r of outputs) {
    const t = r.period;
    if (t == null) continue;
    if (r.nominal_type === 'revenue') bump(baseRev, t, r.amount_p);
    else if (r.nominal_type === 'staff_cost' || r.nominal_type === 'overhead' || r.nominal_type === 'cost_of_sales') bump(baseCost, t, r.amount_p);
    else if (r.nominal_type === 'pnl.income_inflation_uplift') bump(upliftRev, t, r.amount_p);
    else if (r.nominal_type === 'pnl.cost_inflation_uplift') bump(upliftCost, t, -r.amount_p);   // emitted negative
  }
  return {
    incomeFactor: (t) => (baseRev.get(t) > 0 ? 1 + (upliftRev.get(t) || 0) / baseRev.get(t) : 1),
    costFactor:   (t) => (baseCost.get(t) > 0 ? 1 + (upliftCost.get(t) || 0) / baseCost.get(t) : 1),
  };
}

/**
 * Revenue share per period for a filtered scope — the fraction of shared
 * (group-level) rows the scope carries. Zero-revenue periods borrow the
 * nearest following period's share. Returns Map(t -> share); shares are
 * all 1 when entityIds is null.
 */
export function revenueSharesByPeriod(outputs, periods, entityIds) {
  const shareByT = new Map();
  if (!entityIds) {
    for (const t of periods) shareByT.set(t, 1);
    return shareByT;
  }
  const scoped = new Map(), total = new Map();
  for (const r of outputs) {
    if (r.nominal_type !== 'revenue' || r.period == null) continue;
    total.set(r.period, (total.get(r.period) || 0) + r.amount_p);
    if (r.entity_id != null && entityIds.has(r.entity_id)) {
      scoped.set(r.period, (scoped.get(r.period) || 0) + r.amount_p);
    }
  }
  const raw = periods.map(t => ((total.get(t) || 0) > 0 ? (scoped.get(t) || 0) / total.get(t) : null));
  let next = 1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] == null) raw[i] = next; else next = raw[i];
  }
  periods.forEach((t, i) => shareByT.set(t, raw[i]));
  return shareByT;
}

export function aggregatedAsOutputRows(map) {
  const rows = [];
  for (const [key, amount_p] of map) {
    const idx = key.indexOf('::');
    rows.push({
      nominal_type: key.slice(0, idx),
      period: Number(key.slice(idx + 2)),
      amount_p,
      module_key: 'scoped',
      line_label: '',
    });
  }
  return rows;
}
