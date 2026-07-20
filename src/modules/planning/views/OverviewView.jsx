import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Info, TrendingDown, Sparkles } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import {
  fmtGBP, fmtGBPSigned, fmtPct,
  buildNarrative, computeCapacity, computeClientProfitability, computeChurnScores,
  UK_PRACTICE_BENCHMARKS, scoreAgainstBenchmark,
} from '../lib/projection';

export default function OverviewView() {
  const { projection, clientBillings, clientOverrides, staffLines, staffProfiles, scenario, monthlyActuals, timesheetEntries, pipelineResult } = usePlanning();
  const { months, y1, y2, waterfall } = projection;

  // Derive auxiliary data so the narrator sees the whole picture
  const churnScores = useMemo(
    () => computeChurnScores({ clientBillings, clientOverrides, timesheetEntries }),
    [clientBillings, clientOverrides, timesheetEntries]
  );
  const profitability = useMemo(
    () => computeClientProfitability({ clientBillings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario }),
    [clientBillings, clientOverrides, timesheetEntries, staffLines, staffProfiles, scenario]
  );
  const capacityByMonth = useMemo(
    () => computeCapacity({ staffLines, scenario, months, effectiveRatePerHour: 100 }),
    [staffLines, scenario, months]
  );
  const findings = useMemo(
    () => buildNarrative({
      projection, clientBillings, clientOverrides, staffLines,
      churnScores, profitability, capacityByMonth, pipelineResult, scenario,
    }),
    [projection, clientBillings, clientOverrides, staffLines, churnScores, profitability, capacityByMonth, pipelineResult, scenario]
  );

  const actualMonths = months.filter((m) => m.isActual);
  const varianceRevY1 = actualMonths.reduce((s, m) => s + (m.varianceRevenue || 0), 0);
  const varianceProfitY1 = actualMonths.reduce((s, m) => s + (m.varianceProfit || 0), 0);

  if (!months.length) {
    return <div style={{ color: '#94a3b8', fontSize: 13 }}>No projection yet — add a scenario.</div>;
  }

  // Client concentration
  const activeBook = clientBillings.map((b) => {
    const ov = clientOverrides.find((o) => o.live_billing_id === b.id);
    const fee = ov?.fee_override_monthly != null ? Number(ov.fee_override_monthly) : b.monthly_net;
    return { ...b, fee, status: ov?.status || 'active', endMonth: ov?.end_month };
  });
  const totalMonthly = activeBook.reduce((s, c) => s + c.fee, 0);
  const sortedByFee = [...activeBook].sort((a, b) => b.fee - a.fee);
  const top10Share = totalMonthly > 0 ? sortedByFee.slice(0, 10).reduce((s, c) => s + c.fee, 0) / totalMonthly : 0;
  const top5Share = totalMonthly > 0 ? sortedByFee.slice(0, 5).reduce((s, c) => s + c.fee, 0) / totalMonthly : 0;

  // Risk exposure
  const atRiskMonthly = activeBook.filter((c) => c.status === 'at_risk').reduce((s, c) => s + c.fee, 0);
  const endingMonthly = activeBook.filter((c) => c.status === 'ending').reduce((s, c) => s + c.fee, 0);

  // Fee-earner metrics (treat every staff_line as a fee earner for now)
  const feeEarners = staffLines.length;
  const revPerEarner = feeEarners > 0 ? y1.revenue / feeEarners : 0;
  const profitPerEarner = feeEarners > 0 ? y1.ebitda / feeEarners : 0;

  return (
    <div>
      {/* AI narrator — plain-English read of the plan */}
      {findings.length > 0 && (
        <div style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', color: '#f8fafc', borderRadius: 12, padding: '18px 22px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Sparkles size={16} style={{ color: '#fbbf24' }} />
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, fontWeight: 500, margin: 0, color: '#f8fafc' }}>
              The plan at a glance
            </h3>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {findings.length} finding{findings.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {findings.slice(0, 8).map((f, i) => {
              const meta = {
                critical: { icon: AlertTriangle, colour: '#f87171' },
                warning:  { icon: AlertTriangle, colour: '#fbbf24' },
                info:     { icon: Info,          colour: '#93c5fd' },
                positive: { icon: CheckCircle2,  colour: '#4ade80' },
              }[f.severity] || { icon: Info, colour: '#cbd5e1' };
              const Icon = meta.icon;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: 1.55 }}>
                  <Icon size={14} style={{ color: meta.colour, flexShrink: 0, marginTop: 2 }} />
                  <span style={{ color: '#e2e8f0' }}>{f.text}</span>
                </div>
              );
            })}
            {findings.length > 8 && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                …and {findings.length - 8} more. Lower-priority findings hidden.
              </div>
            )}
          </div>
        </div>
      )}

      {/* UK practice benchmarks */}
      <BenchmarkCard projection={projection} staffLines={staffLines} />

      {/* Rolling-forecast banner — shows when actuals are available */}
      {actualMonths.length > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, display: 'flex', gap: 18, alignItems: 'center' }}>
          <div>
            <b style={{ color: '#0e7fe0' }}>Rolling forecast:</b> {actualMonths.length} actual month{actualMonths.length !== 1 ? 's' : ''} overlaid ({actualMonths[0].label} → {actualMonths[actualMonths.length - 1].label}).
          </div>
          <div style={{ color: '#64748b' }}>Revenue variance: <b style={{ color: varianceRevY1 >= 0 ? '#059669' : '#dc2626' }}>{varianceRevY1 >= 0 ? '+' : ''}{fmtGBP(varianceRevY1)}</b></div>
          <div style={{ color: '#64748b' }}>Profit variance: <b style={{ color: varianceProfitY1 >= 0 ? '#059669' : '#dc2626' }}>{varianceProfitY1 >= 0 ? '+' : ''}{fmtGBP(varianceProfitY1)}</b></div>
        </div>
      )}

      {/* Hero KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <Kpi
          label="Y1 revenue"
          value={fmtGBP(y1.revenue)}
          sub={`Y2 ${fmtGBP(y2.revenue)} (${deltaPct(y1.revenue, y2.revenue)})`}
          colour="#0e7fe0"
        />
        <Kpi
          label="Y1 EBITDA"
          value={fmtGBP(y1.ebitda)}
          sub={`${fmtPct(y1.margin)} margin`}
          colour={y1.ebitda >= 0 ? '#059669' : '#dc2626'}
        />
        <Kpi
          label="Profit after owner comp"
          value={fmtGBP(y1.profit)}
          sub={`Owner comp ${fmtGBP(y1.ownerComp)}`}
          colour={y1.profit >= 0 ? '#0f172a' : '#dc2626'}
        />
        <Kpi
          label="Revenue / fee earner"
          value={fmtGBP(revPerEarner)}
          sub={`${feeEarners} earners · EBITDA/head ${fmtGBP(profitPerEarner)}`}
          colour="#7c3aed"
        />
        <Kpi
          label="Top-10 concentration"
          value={fmtPct(top10Share)}
          sub={`Top-5 ${fmtPct(top5Share)}`}
          colour="#f59e0b"
        />
        <Kpi
          label="At-risk revenue"
          value={fmtGBP((atRiskMonthly + endingMonthly) * 12)}
          sub={`${fmtGBP(atRiskMonthly * 12)} at risk · ${fmtGBP(endingMonthly * 12)} ending`}
          colour={(atRiskMonthly + endingMonthly) > 0 ? '#dc2626' : '#94a3b8'}
        />
      </div>

      {/* Drivers waterfall */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
          <h3 style={h3}>Y1 → Y2 profit drivers</h3>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            Fee uplift {scenario?.fee_uplift_pct || 0}% · Pay rise {scenario?.pay_rise_pct || 0}% · Churn {scenario?.churn_pct_annual || 0}%
          </div>
        </div>
        <Waterfall waterfall={waterfall} />
      </div>

      {/* Stacked 24-month chart */}
      <div style={{ ...card, marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
          <h3 style={h3}>24-month forecast</h3>
          <Legend />
        </div>
        <StackedChart months={months} />
      </div>

      {/* Monthly P&L table */}
      <div style={{ ...card, marginTop: 20, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a' }}>
          Month-by-month P&L
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 920 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={{ ...th, textAlign: 'left' }}>Month</th>
                <th style={th}>Revenue</th>
                <th style={th}>Staff</th>
                <th style={th}>Overheads</th>
                <th style={th}>EBITDA</th>
                <th style={th}>Owner comp</th>
                <th style={th}>Profit</th>
                <th style={th}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.index} style={{ borderTop: '1px solid #f1f5f9', background: m.isActual ? '#f0fdf4' : undefined }}>
                  <td style={{ ...td, textAlign: 'left', color: '#64748b' }}>
                    {m.label}
                    {m.isActual && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#059669', background: '#dcfce7', padding: '1px 5px', borderRadius: 3 }}>ACTUAL</span>}
                  </td>
                  <td style={{ ...td, color: '#0e7fe0' }}>{fmtGBP(m.revenue)}</td>
                  <td style={td}>{fmtGBP(m.staffCost)}</td>
                  <td style={td}>{fmtGBP(m.overheads)}</td>
                  <td style={{ ...td, color: m.ebitda >= 0 ? '#059669' : '#dc2626', fontWeight: 600 }}>{fmtGBP(m.ebitda)}</td>
                  <td style={{ ...td, color: '#7c3aed' }}>{fmtGBP(m.ownerComp)}</td>
                  <td style={{ ...td, color: m.profit >= 0 ? '#0f172a' : '#dc2626', fontWeight: 700 }}>{fmtGBP(m.profit)}</td>
                  <td style={td}>{fmtPct(m.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function deltaPct(a, b) {
  if (!a) return '—';
  const d = (b - a) / a;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${(d * 100).toFixed(1)}%`;
}

function BenchmarkCard({ projection, staffLines }) {
  const { y1 } = projection;
  const feeEarners = staffLines.filter((s) => s.is_fee_earner !== false).length;

  // Unfed-model honesty: with no cost lines every ratio here is meaningless
  // (revenue = EBITDA = profit reads as "100% margin, top quartile"). Say
  // what's missing instead of celebrating garbage.
  const modelFed = (y1.staffCost || 0) > 0 || (y1.overheads || 0) > 0 || (y1.ownerComp || 0) > 0;
  if (!modelFed) {
    return (
      <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#92400e', margin: '0 0 6px' }}>
          UK practice benchmarks — needs setup
        </h3>
        <p style={{ fontSize: 12.5, color: '#92400e', margin: 0, lineHeight: 1.6 }}>
          This scenario has no staff, overhead, or owner-comp lines yet, so margin and cost-ratio
          benchmarks would be meaningless. Add costs on the <strong>Staff</strong>, <strong>Overheads</strong> and{' '}
          <strong>Owner comp</strong> tabs and the benchmarks will appear.
        </p>
      </div>
    );
  }

  const metrics = [
    {
      key: 'ebitda_margin',
      bench: UK_PRACTICE_BENCHMARKS.ebitda_margin,
      value: y1.margin,
      format: (v) => fmtPct(v),
    },
    {
      key: 'staff_to_revenue',
      bench: UK_PRACTICE_BENCHMARKS.staff_to_revenue,
      value: y1.revenue > 0 ? y1.staffCost / y1.revenue : 0,
      format: (v) => fmtPct(v),
    },
    {
      key: 'revenue_per_fee_earner',
      bench: UK_PRACTICE_BENCHMARKS.revenue_per_fee_earner,
      value: feeEarners > 0 ? y1.revenue / feeEarners : 0,
      format: (v) => fmtGBP(v),
    },
    {
      key: 'overhead_ratio',
      bench: UK_PRACTICE_BENCHMARKS.overhead_ratio,
      value: y1.revenue > 0 ? y1.overheads / y1.revenue : 0,
      format: (v) => fmtPct(v),
    },
    {
      key: 'gross_margin',
      bench: UK_PRACTICE_BENCHMARKS.gross_margin,
      value: y1.revenue > 0 ? (y1.revenue - y1.staffCost) / y1.revenue : 0,
      format: (v) => fmtPct(v),
    },
  ];

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          UK practice benchmarks
        </h3>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>
          Sources: ICAEW Benchmarking · Practice Track · Xero Accounting Industry Report
        </span>
      </div>
      <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
        Your Y1 plan plotted against typical ranges for UK accountancy practices. Top-quartile boundary shown; "typical" is the median.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {metrics.map((m) => (
          <BenchmarkRow key={m.key} {...m} />
        ))}
      </div>
    </div>
  );
}

function BenchmarkRow({ bench, value, format }) {
  const score = scoreAgainstBenchmark(value, bench);
  const scoreLabel = { topQ: 'Top quartile', typical: 'Typical', low: 'Below average', below: 'Below benchmark', unknown: '—' }[score];
  const scoreColour = { topQ: '#059669', typical: '#0e7fe0', low: '#f59e0b', below: '#dc2626', unknown: '#94a3b8' }[score];

  // Build a horizontal track showing low / typical / topQ marks and where value sits
  const { low, typical, topQ, lowerIsBetter } = bench;
  // Pick a range min..max that contains everything sensibly
  const vals = [low, typical, topQ, value].filter((x) => x != null);
  const min = lowerIsBetter ? Math.min(...vals, 0) : 0;
  const max = Math.max(...vals) * 1.1;
  const span = max - min || 1;
  const pct = (x) => Math.max(0, Math.min(100, ((x - min) / span) * 100));

  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 }}>{bench.label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: scoreColour }}>{scoreLabel}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{format(value || 0)}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          Typical {format(typical)} · Top-Q {format(topQ)}
        </span>
      </div>
      <div style={{ position: 'relative', height: 6, background: '#e2e8f0', borderRadius: 3 }}>
        {/* Typical zone shaded */}
        <div style={{ position: 'absolute', left: `${pct(lowerIsBetter ? topQ : low)}%`, width: `${pct(lowerIsBetter ? low : topQ) - pct(lowerIsBetter ? topQ : low)}%`, height: '100%', background: '#bfdbfe', borderRadius: 3 }} />
        {/* Marker for our value */}
        <div style={{ position: 'absolute', left: `calc(${pct(value)}% - 5px)`, top: -3, width: 10, height: 12, background: scoreColour, borderRadius: 2, border: '2px solid #fff' }} />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, colour }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Waterfall({ waterfall }) {
  const { y1Profit, y2Profit, steps } = waterfall;
  // Build bars: start, steps in order, end
  const all = [{ label: `Y1 profit`, value: y1Profit, type: 'anchor' }, ...steps.map((s) => ({ ...s, type: s.value >= 0 ? 'pos' : 'neg' })), { label: `Y2 profit`, value: y2Profit, type: 'anchor' }];
  const absValues = all.flatMap((b, i) => {
    if (b.type === 'anchor') return [0, b.value];
    const prior = all.slice(0, i).reduce((acc, x) => x.type === 'anchor' ? x.value : acc + x.value, 0);
    return [prior, prior + b.value];
  });
  const min = Math.min(0, ...absValues);
  const max = Math.max(0, ...absValues);
  const range = Math.max(1, max - min);
  const chartH = 140;
  const scale = (v) => (v - min) / range * chartH;

  let running = 0;
  const bars = all.map((b, i) => {
    if (b.type === 'anchor') {
      const top = chartH - scale(b.value);
      const h = scale(b.value);
      running = b.value;
      return { ...b, top, h };
    } else {
      const start = running;
      const end = running + b.value;
      const top = chartH - scale(Math.max(start, end));
      const h = Math.abs(scale(end) - scale(start));
      running = end;
      return { ...b, top, h };
    }
  });

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bars.length}, 1fr)`, alignItems: 'end', gap: 8, height: chartH + 40, position: 'relative' }}>
        {bars.map((b, i) => (
          <div key={i} style={{ position: 'relative', height: '100%' }}>
            <div style={{
              position: 'absolute',
              top: b.top,
              height: Math.max(b.h, 2),
              left: 4, right: 4,
              background: b.type === 'anchor' ? '#0f172a' : b.type === 'pos' ? '#059669' : '#dc2626',
              borderRadius: 4,
            }} />
            <div style={{ position: 'absolute', bottom: -22, left: 0, right: 0, textAlign: 'center', fontSize: 10, color: '#64748b' }}>
              {b.type === 'anchor' ? fmtGBP(b.value) : fmtGBPSigned(b.value)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bars.length}, 1fr)`, gap: 8, marginTop: 12 }}>
        {bars.map((b, i) => (
          <div key={i} style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', lineHeight: 1.3 }}>{b.label}</div>
        ))}
      </div>
    </div>
  );
}

function StackedChart({ months }) {
  const max = Math.max(...months.map((m) => Math.max(m.revenue, m.staffCost + m.overheads + m.ownerComp))) || 1;
  const h = 200;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 3, alignItems: 'end', height: h, paddingBottom: 4, borderBottom: '1px solid #e5e7eb', position: 'relative' }}>
        {months.map((m) => {
          const staffH = (m.staffCost / max) * h;
          const ohH = (m.overheads / max) * h;
          const ownerH = (m.ownerComp / max) * h;
          const revH = (m.revenue / max) * h;
          return (
            <div key={m.index} title={`${m.label}\nRevenue ${fmtGBP(m.revenue)}\nStaff ${fmtGBP(m.staffCost)}\nOverheads ${fmtGBP(m.overheads)}\nOwner comp ${fmtGBP(m.ownerComp)}\nProfit ${fmtGBP(m.profit)}`}
              style={{ display: 'flex', alignItems: 'flex-end', gap: 2, justifyContent: 'center', height: '100%' }}>
              {/* Cost stack */}
              <div style={{ display: 'flex', flexDirection: 'column-reverse', width: '42%' }}>
                <div style={{ height: staffH, background: '#7c3aed' }} />
                <div style={{ height: ohH, background: '#f59e0b' }} />
                <div style={{ height: ownerH, background: '#a3a3a3', borderRadius: '2px 2px 0 0' }} />
              </div>
              {/* Revenue bar */}
              <div style={{ width: '42%', height: revH, background: '#0e7fe0', borderRadius: '2px 2px 0 0' }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 3, marginTop: 4 }}>
        {months.map((m) => (
          <div key={m.index} style={{ fontSize: 9, color: '#94a3b8', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {m.index % 3 === 0 ? m.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#64748b' }}>
      <LegendItem colour="#0e7fe0" label="Revenue" />
      <LegendItem colour="#7c3aed" label="Staff" />
      <LegendItem colour="#f59e0b" label="Overheads" />
      <LegendItem colour="#a3a3a3" label="Owner comp" />
    </div>
  );
}
function LegendItem({ colour, label }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: colour }} />{label}</span>;
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: 0 };
const th = { padding: '10px 12px', textAlign: 'right', fontWeight: 600 };
const td = { padding: '7px 12px', textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' };
