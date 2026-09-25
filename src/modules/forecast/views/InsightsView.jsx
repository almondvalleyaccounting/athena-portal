// AI Insights — rule-based observations on the model state, plus
// reconciliation findings surfaced by the engine. This is deterministic
// for v1; an LLM-backed pass can be wired later by replacing the
// `generateInsights` body with a server call.

import React, { useMemo } from 'react';
import { colors, fmtP, fontStack, H2, serifStack } from '../components/ui';

export default function InsightsView({ outputs, findings, forecast, periods, entities = [] }) {
  const insights = useMemo(() => generateInsights({ outputs, findings, forecast, periods, entities }),
    [outputs, findings, forecast, periods, entities]);
  const errs = findings.filter(f => f.severity === 'error');

  return (
    <div>
      <H2>
        Insights
        <span style={{ fontSize: 13, fontWeight: 400, color: colors.muted, marginLeft: 8, fontFamily: fontStack }}>
          · updates when you recompute
        </span>
      </H2>

      {errs.length > 0 && (
        <div style={{ padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: colors.red, marginBottom: 6 }}>
            Reconciliation issues ({errs.length})
          </div>
          <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: '#991b1b' }}>
            {errs.slice(0, 5).map((f, i) => (
              <li key={i}><code style={{ fontSize: 12 }}>{f.code}</code> · t={f.period} · {f.message}</li>
            ))}
            {errs.length > 5 && <li style={{ color: colors.muted }}>+ {errs.length - 5} more</li>}
          </ul>
        </div>
      )}

      {insights.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 14, padding: 24, textAlign: 'center', background: colors.bgSoft, borderRadius: 8 }}>
          Recompute the forecast to see insights.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {insights.map((ins, i) => (
            <InsightCard key={i} insight={ins} />
          ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({ insight }) {
  const tone = insight.tone || 'neutral';
  const palette = {
    positive: { bg: '#ecfdf5', border: '#a7f3d0', label: '#065f46' },
    warning:  { bg: '#fef3c7', border: '#fde68a', label: '#7c2d12' },
    risk:     { bg: '#fef2f2', border: '#fecaca', label: '#991b1b' },
    neutral:  { bg: '#f8fafc', border: '#e5e7eb', label: '#475569' },
  }[tone];
  return (
    <div style={{
      padding: 14, background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 8,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: palette.label, marginBottom: 4 }}>
        {insight.category}
      </div>
      <div style={{ fontSize: 14, color: colors.ink, lineHeight: 1.5 }}>
        {insight.headline}
      </div>
      {insight.detail && (
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 4 }}>
          {insight.detail}
        </div>
      )}
    </div>
  );
}

// ── Rule engine ──────────────────────────────────────────────────

function generateInsights({ outputs, findings, forecast, periods, entities }) {
  const insights = [];

  if (outputs.length === 0) return insights;

  const horizon = forecast?.horizon_months || periods.length;
  const sumByNominalYear = (nt, year) => {
    const start = (year - 1) * 12;
    const end = Math.min(start + 11, horizon - 1);
    let s = 0;
    for (const r of outputs) {
      if (r.nominal_type !== nt) continue;
      if (r.period < start || r.period > end) continue;
      s += r.amount_p;
    }
    return s;
  };
  const lastByNominal = (nt) => {
    const row = [...outputs].filter(r => r.nominal_type === nt).sort((a, b) => a.period - b.period).pop();
    return row?.amount_p ?? 0;
  };
  const minBy = (nt) => outputs.filter(r => r.nominal_type === nt)
    .reduce((acc, r) => (acc == null || r.amount_p < acc.amount_p ? r : acc), null);
  const periodLabelFor = (t) => {
    const d = forecast?.opening_period ? new Date(forecast.opening_period) : null;
    if (!d) return `month ${t}`;
    const m = new Date(d.getFullYear(), d.getMonth() + t, 1);
    return m.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
  };

  // ── Ratio compliance (top of stack — regulatory) ──
  const ratioBreach = findings.find(f => f.code === 'staff.ratio_breach');
  if (ratioBreach) {
    insights.push({
      category: 'Ratio breach',
      tone: 'risk',
      headline: ratioBreach.message.split('. ').slice(0, 2).join('. ') + '.',
      detail: ratioBreach.message.split('. ').slice(2).join('. '),
    });
  } else {
    // Find the latest ratio compliance value
    const lastRatio = [...outputs].filter(o => o.nominal_type === 'metric.ratio_compliance' && !o.entity_id).sort((a, b) => a.period - b.period).pop();
    if (lastRatio) {
      const x = lastRatio.amount_p / 10000;
      const tone = x >= 1.1 ? 'positive' : 'neutral';
      insights.push({
        category: 'Ratio compliance',
        tone,
        headline: `Staff ratios are met with ${x.toFixed(2)}× cover at the end of the forecast.`,
        detail: x >= 1.2
          ? 'Room to absorb vacancies. More apprentices in the mix could cut cost and still meet ratios.'
          : 'Ratios are met with little slack. One vacancy could take you below ratio. Consider modelling a buffer.',
      });
    }
  }

  // ── Cash trough ──
  const cashTrough = minBy('bs.cash');
  if (cashTrough && cashTrough.amount_p < 0) {
    insights.push({
      category: 'Cash risk',
      tone: 'risk',
      headline: `Cash goes negative in ${periodLabelFor(cashTrough.period)} (lowest ${fmtP(cashTrough.amount_p, { compact: true })}).`,
      detail: 'Without more funding this needs an overdraft. Options: a director loan, a bigger bank facility or staggered openings.',
    });
  } else if (cashTrough) {
    const lo = cashTrough.amount_p;
    if (lo > 0 && lo < 25_00_00) {
      insights.push({
        category: 'Cash buffer',
        tone: 'warning',
        headline: `Cash falls to ${fmtP(lo, { compact: true })} in ${periodLabelFor(cashTrough.period)}, a thin buffer.`,
        detail: 'Lenders usually want a buffer of over £100k. A small director loan or longer supplier terms would cover it.',
      });
    }
  }

  // ── EBITDA margin trajectory ──
  const totalYears = Math.ceil(horizon / 12);
  const lastYear = totalYears;
  const revLY = sumByNominalYear('pnl.revenue_total', lastYear);
  const ebitLY = sumByNominalYear('pnl.ebitda', lastYear);
  if (revLY > 0) {
    const margin = (ebitLY / revLY) * 100;
    if (margin >= 18) {
      insights.push({
        category: 'Profitability',
        tone: 'positive',
        headline: `Year ${lastYear} EBITDA margin of ${margin.toFixed(1)}% is healthy for a nursery (typically 15–22%).`,
        detail: `Revenue ${fmtP(revLY, { compact: true })} → EBITDA ${fmtP(ebitLY, { compact: true })}.`,
      });
    } else if (margin >= 10) {
      insights.push({
        category: 'Profitability',
        tone: 'neutral',
        headline: `Year ${lastYear} EBITDA margin of ${margin.toFixed(1)}% is modest for the sector.`,
        detail: 'Established nurseries typically make 15–22%. Levers: occupancy, fee increases and staffing efficiency.',
      });
    } else {
      insights.push({
        category: 'Profitability',
        tone: 'warning',
        headline: `Year ${lastYear} EBITDA margin of ${margin.toFixed(1)}% is below the sector floor of 15%.`,
        detail: 'Check the ratio assumptions, weekly fees and central admin costs.',
      });
    }
  }

  // ── DSCR ──
  const dscrLast = lastByNominal('metric.dscr') / 10000;
  if (dscrLast > 0) {
    if (dscrLast >= 1.5) {
      insights.push({
        category: 'Debt service',
        tone: 'positive',
        headline: `DSCR of ${dscrLast.toFixed(2)}× at the end of the forecast, well above lender minimums.`,
        detail: 'Most UK childcare lenders set a DSCR covenant of at least 1.25×.',
      });
    } else if (dscrLast >= 1.25) {
      insights.push({
        category: 'Debt service',
        tone: 'warning',
        headline: `DSCR of ${dscrLast.toFixed(2)}× meets the usual 1.25× covenant, with little headroom.`,
        detail: 'Try lower occupancy or smaller fee increases to see when it breaks.',
      });
    } else {
      insights.push({
        category: 'Debt service',
        tone: 'risk',
        headline: `DSCR of ${dscrLast.toFixed(2)}× is below the 1.25× covenant most lenders require.`,
        detail: 'Reduce debt, raise EBITDA or extend the loan term to lift cover.',
      });
    }
  }

  // ── Funded vs private mix ──
  const fundedY = sumByNominalYear('pnl.revenue_total', lastYear);
  if (fundedY > 0) {
    let priv = 0, funded = 0;
    const start = (lastYear - 1) * 12;
    const end = Math.min(start + 11, horizon - 1);
    for (const r of outputs) {
      if (r.module_key !== 'services_childcare') continue;
      if (r.period < start || r.period > end) continue;
      if (r.tags?.revenue_kind === 'funded') funded += r.amount_p;
      else priv += r.amount_p;
    }
    const total = priv + funded;
    if (total > 0) {
      const fundedPct = (funded / total) * 100;
      if (fundedPct > 40) {
        insights.push({
          category: 'Revenue mix',
          tone: 'warning',
          headline: `Funded hours are ${fundedPct.toFixed(0)}% of year ${lastYear} income, so council rate changes matter.`,
          detail: 'The Scottish 1140-hour rate follows each council\'s budget and rarely keeps up with cost inflation.',
        });
      } else if (fundedPct < 15) {
        insights.push({
          category: 'Revenue mix',
          tone: 'neutral',
          headline: `Funded hours are only ${fundedPct.toFixed(0)}% of year ${lastYear} income, so this is mainly a private-fee business.`,
          detail: 'Less exposed to council rates, but may be missing out on 1140-hour partnership income.',
        });
      }
    }
  }

  // ── Occupancy ──
  for (const e of entities) {
    const target = e.config?.target_occupancy_pct;
    if (target && target > 92) {
      insights.push({
        category: 'Occupancy',
        tone: 'warning',
        headline: `${e.label}: target occupancy of ${target}% is high. UK nurseries usually run at 80–88%.`,
        detail: 'Most operators plan on 85% once settled. 92% or more rarely holds across every room.',
      });
    }
  }

  // ── Loan concentration ──
  const directorBal = lastByNominal('bs.directors_loans');
  const longTerm = lastByNominal('bs.long_term_loans');
  const equity = lastByNominal('bs.equity');
  if (directorBal > 0 && equity > 0 && directorBal > equity * 1.5) {
    insights.push({
      category: 'Capital structure',
      tone: 'warning',
      headline: `Directors\' loans (${fmtP(directorBal, { compact: true })}) are more than 1.5× equity at the end of the forecast.`,
      detail: 'Heavy director funding is normal early on, but lenders may want it turned into equity before refinancing.',
    });
  }

  // ── Reconciliation passing ──
  const errCount = findings.filter(f => f.severity === 'error').length;
  if (errCount === 0) {
    insights.push({
      category: 'Model checks',
      tone: 'positive',
      headline: 'The balance sheet balances and the cash flow matches the change in cash in every month.',
      detail: 'The P&L, balance sheet and cash flow agree, so the figures are safe to share with lenders or investors.',
    });
  }

  return insights;
}
