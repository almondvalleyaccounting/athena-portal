import React, { useMemo } from 'react';
import { groupPeriods, sumLine, STAFF_ROWS, AGE_BANDS, AGE_BAND_LABELS } from '../lib/export/aggregations';
import { buildOccupancyIndex, occKey } from '../lib/occupancy.js';
import { colors, fontStack, Section } from '../components/ui';

// ═══ Overview — the whole model on one numerical page ═══════════════════
// Year columns (Y1..Y5) + a 5-yr column. Group-wide (no location filter):
// the pnl.* / cf.* / bs.* summary rows this reads are engine group-level
// emissions, one row per period. High level, but each section carries the
// drivers of the result: rooms (places vs forecast FTE), staffing (heads
// and loaded cost per head), the cost stack, and the cash floor.

const fmtMoney = (p) => {
  if (p == null) return '—';
  const gbp = p / 100 || 0;   // `|| 0` collapses -0 (from sign-flipped zero cost rows)
  const abs = Math.abs(gbp);
  if (abs >= 1_000_000) return `£${(gbp / 1_000_000).toFixed(2)}m`;
  if (abs >= 100_000)   return `£${Math.round(gbp / 1000).toLocaleString()}k`;
  if (abs >= 1_000)     return `£${(gbp / 1000).toFixed(1)}k`;
  return `£${Math.round(gbp).toLocaleString()}`;
};
const fmtNum = (n, dp = 1) => n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPct = (n, dp = 0) => n == null ? '—' : `${Number(n).toFixed(dp)}%`;

export default function OverviewView({ outputs = [], forecast, periods = [], entities = [] }) {
  const model = useMemo(() => {
    if (!outputs.length || !periods.length) return null;

    const YB = groupPeriods(periods, 'annual', forecast?.opening_period);
    const allPeriods = periods;
    const opening = forecast?.opening_period ? new Date(forecast.opening_period) : null;
    const monthLabel = (p) => {
      if (!opening) return `M${p}`;
      const d = new Date(opening.getFullYear(), opening.getMonth() + p, 1);
      return d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
    };

    // ── Children by room: places (max) vs forecast FTE ──────────────
    const occIdx = buildOccupancyIndex(outputs);
    const bandRows = AGE_BANDS.map(band => {
      const cells = YB.map(g => {
        const end = Math.max(...g.periods);
        const caps = entities
          .map(e => ({ e, cap: Number(e.config?.capacity_by_age_band?.[band] || 0), opn: e.config?.opening_month_offset ?? 0 }))
          .filter(x => x.cap > 0 && x.opn <= end);
        const places = caps.reduce((s, x) => s + x.cap, 0);
        let fteSum = 0;
        for (const t of g.periods) {
          for (const x of caps) {
            const occ = occIdx.get(occKey(x.e.id, band, t)) ?? 0;   // percent 0-100
            fteSum += x.cap * occ / 100;
          }
        }
        const avgFte = g.periods.length ? fteSum / g.periods.length : 0;
        return { places, avgFte };
      });
      return { band, label: AGE_BAND_LABELS[band], cells };
    }).filter(r => r.cells.some(c => c.places > 0));

    const kidsTotal = YB.map((_, gi) => ({
      places: bandRows.reduce((s, r) => s + r.cells[gi].places, 0),
      avgFte: bandRows.reduce((s, r) => s + r.cells[gi].avgFte, 0),
    }));

    // ── Staffing: heads + loaded cost per head, by role ─────────────
    // staff_cost rows carry tags.role + tags.headcount per entity per month;
    // avg heads = mean of the monthly totals across the year.
    const roleAgg = new Map();   // role -> { cost: number[], hcByPeriod: Map }
    for (const r of outputs) {
      if (r.nominal_type !== 'staff_cost') continue;
      const role = r.tags?.role;
      if (!role) continue;
      let a = roleAgg.get(role);
      if (!a) { a = { cost: YB.map(() => 0), hcByPeriod: new Map() }; roleAgg.set(role, a); }
      const gi = Math.floor(r.period / 12);
      if (gi >= 0 && gi < YB.length) a.cost[gi] += r.amount_p;
      a.hcByPeriod.set(r.period, (a.hcByPeriod.get(r.period) || 0) + (Number(r.tags?.headcount) || 0));
    }
    const staffRows = STAFF_ROWS
      .filter(row => roleAgg.has(row.role) && roleAgg.get(row.role).cost.some(c => c !== 0))
      .map(row => {
        const a = roleAgg.get(row.role);
        const cells = YB.map((g, gi) => {
          let hcSum = 0;
          for (const t of g.periods) hcSum += a.hcByPeriod.get(t) || 0;
          const avgHc = g.periods.length ? hcSum / g.periods.length : 0;
          const cost = a.cost[gi];
          return { avgHc, cost, costPerHead: avgHc > 0 ? cost / avgHc : null };
        });
        return { ...row, cells };
      });

    // ── Statement lines per year (+ 5-yr) ───────────────────────────
    const line = (t, agg) => YB.map(g => sumLine(outputs, t, g.periods, agg || 'sum'));
    const tot = (t) => sumLine(outputs, t, allPeriods, 'sum');

    // Cost lines and cash-out lines are stored NEGATIVE (statement sign
    // convention); the Overview presents them as positive cost magnitudes.
    const neg = (a) => a.map(v => -v);
    const revPrivate  = line('pnl.revenue_private');
    const revFunded   = line('pnl.revenue_la_funded');
    const revTotal    = line('pnl.revenue_total');
    const staffDirect = neg(line('pnl.cost_staff_direct'));
    const staffOh     = neg(line('pnl.cost_staff_overhead'));
    const directCosts = neg(line('pnl.cost_direct_costs'));
    const premises    = neg(line('pnl.cost_premises'));
    const utilities   = neg(line('pnl.cost_premises_utilities'));   // inside premises
    const otherOh     = YB.map((g) => -(sumLine(outputs, 'pnl.cost_other_overhead', g.periods) + sumLine(outputs, 'pnl.cost_admin', g.periods)));
    const preOpening  = neg(line('pnl.cost_pre_opening'));
    const costTotal   = neg(line('pnl.cost_total'));
    const ebitda      = line('pnl.ebitda');
    const pbt         = line('pnl.pbt');
    const capex       = neg(line('cf.out.capex'));
    const drawdown    = line('cf.in.debt_drawdown');

    // ── Cash floor: monthly bs.cash series (one group row per period) ─
    const cashAt = new Map();
    for (const r of outputs) if (r.nominal_type === 'bs.cash') cashAt.set(r.period, r.amount_p);
    const cashCells = YB.map(g => {
      let min = null, minT = null, close = null;
      for (const t of g.periods) {
        if (!cashAt.has(t)) continue;
        const v = cashAt.get(t);
        if (min == null || v < min) { min = v; minT = t; }
        close = v;
      }
      return { min, minT, close };
    });
    const overallMin = cashCells.reduce((best, c) =>
      c.min != null && (best.min == null || c.min < best.min) ? c : best, { min: null, minT: null });

    return {
      YB, monthLabel, bandRows, kidsTotal, staffRows,
      revPrivate, revFunded, revTotal, staffDirect, staffOh, directCosts,
      premises, utilities, otherOh, preOpening, costTotal, ebitda, pbt,
      capex, drawdown, cashCells, overallMin,
      totals: {
        revPrivate: tot('pnl.revenue_private'), revFunded: tot('pnl.revenue_la_funded'),
        revTotal: tot('pnl.revenue_total'),
        staffDirect: -tot('pnl.cost_staff_direct'), staffOh: -tot('pnl.cost_staff_overhead'),
        directCosts: -tot('pnl.cost_direct_costs'),
        premises: -tot('pnl.cost_premises'), utilities: -tot('pnl.cost_premises_utilities'),
        otherOh: -(tot('pnl.cost_other_overhead') + tot('pnl.cost_admin')),
        preOpening: -tot('pnl.cost_pre_opening'), costTotal: -tot('pnl.cost_total'),
        ebitda: tot('pnl.ebitda'), pbt: tot('pnl.pbt'),
        capex: -tot('cf.out.capex'), drawdown: tot('cf.in.debt_drawdown'),
      },
    };
  }, [outputs, periods, entities, forecast?.opening_period]);

  if (!model) {
    return (
      <Section title="Overview">
        <p style={{ fontSize: 13, color: colors.muted }}>No outputs yet — run a recompute to populate the overview.</p>
      </Section>
    );
  }

  const { YB, monthLabel, bandRows, kidsTotal, staffRows, cashCells, overallMin, totals } = model;
  const n = YB.length;

  // Row builders — every row: { label, cells: string[], total: string, strong?, pctRow? }
  const moneyRow = (label, series, total, opts = {}) => ({
    label, cells: series.map(fmtMoney), total: total != null ? fmtMoney(total) : '—', ...opts,
  });
  const rows = [];
  const section = (label) => rows.push({ section: label });

  section('Children & capacity — average FTE vs places');
  for (const r of bandRows) {
    rows.push({
      label: r.label,
      cells: r.cells.map(c => c.places > 0
        ? `${fmtNum(c.avgFte)} / ${c.places}`
        : '—'),
      total: '—',
    });
  }
  rows.push({
    label: 'All rooms',
    cells: kidsTotal.map(c => c.places > 0 ? `${fmtNum(c.avgFte)} / ${c.places}` : '—'),
    total: '—', strong: true,
  });
  rows.push({
    label: 'Average occupancy',
    cells: kidsTotal.map(c => c.places > 0 ? fmtPct(c.avgFte / c.places * 100) : '—'),
    total: '—',
  });

  section('Income');
  rows.push(moneyRow('Private fees', model.revPrivate, totals.revPrivate));
  rows.push(moneyRow('LA funded', model.revFunded, totals.revFunded));
  rows.push(moneyRow('Total revenue', model.revTotal, totals.revTotal, { strong: true }));

  section('Staffing — average heads');
  for (const r of staffRows) {
    rows.push({ label: r.label, cells: r.cells.map(c => fmtNum(c.avgHc)), total: '—' });
  }
  rows.push({
    label: 'Total heads',
    cells: YB.map((_, gi) => fmtNum(staffRows.reduce((s, r) => s + r.cells[gi].avgHc, 0))),
    total: '—', strong: true,
  });

  section('Staffing — average annual cost per head (loaded: salary + NI + pension)');
  for (const r of staffRows) {
    rows.push({ label: r.label, cells: r.cells.map(c => fmtMoney(c.costPerHead)), total: '—' });
  }

  section('Costs & profitability');
  rows.push(moneyRow('Staff — direct (site)', model.staffDirect, totals.staffDirect));
  rows.push(moneyRow('Staff — overhead (exec / admin)', model.staffOh, totals.staffOh));
  rows.push({
    label: 'Staff % of revenue',
    cells: YB.map((_, gi) => {
      const rev = model.revTotal[gi];
      return rev > 0 ? fmtPct((model.staffDirect[gi] + model.staffOh[gi]) / rev * 100) : '—';
    }),
    total: totals.revTotal > 0 ? fmtPct((totals.staffDirect + totals.staffOh) / totals.revTotal * 100) : '—',
  });
  rows.push(moneyRow('Premises (rent / SC / rates / utilities / maintenance)', model.premises, totals.premises));
  // Memo, not an addend — utilities are inside the premises row above, so
  // this must never read as another line of the stack.
  rows.push(moneyRow('    of which: utilities', model.utilities, totals.utilities));
  rows.push(moneyRow('Direct costs (consumables / food)', model.directCosts, totals.directCosts));
  rows.push(moneyRow('Other overheads & central admin', model.otherOh, totals.otherOh));
  if (model.preOpening.some(v => v !== 0)) rows.push(moneyRow('Pre-opening costs', model.preOpening, totals.preOpening));
  rows.push(moneyRow('Total operating costs', model.costTotal, totals.costTotal, { strong: true }));
  rows.push(moneyRow('EBITDA', model.ebitda, totals.ebitda, { strong: true }));
  rows.push({
    label: 'EBITDA margin',
    cells: YB.map((_, gi) => model.revTotal[gi] > 0 ? fmtPct(model.ebitda[gi] / model.revTotal[gi] * 100) : '—'),
    total: totals.revTotal > 0 ? fmtPct(totals.ebitda / totals.revTotal * 100) : '—',
  });
  rows.push(moneyRow('PBT', model.pbt, totals.pbt));

  section('Cash & investment');
  rows.push(moneyRow('Capex', model.capex, totals.capex));
  if (model.drawdown.some(v => v !== 0)) rows.push(moneyRow('Debt drawdown', model.drawdown, totals.drawdown));
  rows.push({
    label: 'Minimum cash in year',
    cells: cashCells.map(c => c.min == null ? '—' : `${fmtMoney(c.min)} · ${monthLabel(c.minT)}`),
    total: overallMin.min == null ? '—' : `${fmtMoney(overallMin.min)} · ${monthLabel(overallMin.minT)}`,
    strong: true,
  });
  rows.push({
    label: 'Year-end cash',
    cells: cashCells.map(c => fmtMoney(c.close)),
    total: fmtMoney(cashCells[n - 1]?.close),
  });

  return (
    <Section title="Overview — five-year summary">
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 12px' }}>
        Group-wide, from computed outputs. Children and heads are averages across each year
        (places are the registered maximum of sites open in that year); money rows are annual totals
        except cash, which is the month-end balance.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
          <thead>
            <tr>
              <th style={ovTh}>Metric</th>
              {YB.map(g => <th key={g.label} style={{ ...ovTh, textAlign: 'right' }}>{g.label}</th>)}
              <th style={{ ...ovTh, textAlign: 'right', borderLeft: `1px solid ${colors.border}` }}>5-yr</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => r.section ? (
              <tr key={`s${i}`}>
                <td colSpan={n + 2} style={{ padding: '14px 8px 4px', fontSize: 10, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: `1px solid ${colors.border}` }}>
                  {r.section}
                </td>
              </tr>
            ) : (
              <tr key={`r${i}`} style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: r.strong ? colors.bgSoft : '#fff' }}>
                <td style={{ ...ovTd, fontWeight: r.strong ? 700 : 400 }}>{r.label}</td>
                {r.cells.map((c, ci) => (
                  <td key={ci} style={{ ...ovTd, textAlign: 'right', fontWeight: r.strong ? 600 : 400, fontVariantNumeric: 'tabular-nums', color: String(c).startsWith('-') || String(c).startsWith('£-') || String(c).startsWith('-£') ? colors.red : colors.ink }}>
                    {c}
                  </td>
                ))}
                <td style={{ ...ovTd, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', borderLeft: `1px solid ${colors.border}`, color: String(r.total).includes('-') ? colors.red : colors.ink }}>
                  {r.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

const ovTh = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, background: colors.bgSoft, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' };
const ovTd = { padding: '6px 8px', color: colors.ink, verticalAlign: 'middle', whiteSpace: 'nowrap' };
