import React from 'react';
import { usePlanning } from '../PlanningModule';
import { fmtGBP, fmtPct } from '../lib/projection';

export default function DashboardView() {
  const { projection, scenario } = usePlanning();
  const { months } = projection;

  if (!months.length) return <div style={{ color: '#94a3b8', fontSize: 13 }}>No projection yet.</div>;

  const maxAbs = Math.max(
    ...months.map((m) => Math.max(m.revenue, m.staffCost + m.overheads)),
  );

  // Group by year for cleaner two-year summary
  const year1 = months.slice(0, 12);
  const year2 = months.slice(12, 24);
  const sumYear = (arr) => arr.reduce((a, m) => ({
    revenue: a.revenue + m.revenue, staffCost: a.staffCost + m.staffCost,
    overheads: a.overheads + m.overheads, profit: a.profit + m.profit,
  }), { revenue: 0, staffCost: 0, overheads: 0, profit: 0 });
  const y1 = sumYear(year1);
  const y2 = sumYear(year2);

  return (
    <div>
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>24-month forecast</h3>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            Fee uplift {scenario?.fee_uplift_pct || 0}% · Pay rise {scenario?.pay_rise_pct || 0}%
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 11, color: '#64748b' }}>
          <Legend colour="#0e7fe0" label="Revenue" />
          <Legend colour="#7c3aed" label="Staff" />
          <Legend colour="#f59e0b" label="Overheads" />
          <Legend colour="#059669" label="Profit line" />
        </div>

        {/* Chart — bars */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 2, alignItems: 'end', height: 200, borderBottom: '1px solid #e5e7eb', paddingBottom: 4 }}>
          {months.map((m) => {
            const rH = (m.revenue / maxAbs) * 180;
            const sH = (m.staffCost / maxAbs) * 180;
            const oH = (m.overheads / maxAbs) * 180;
            return (
              <div key={m.index} title={`${m.label}\nRev ${fmtGBP(m.revenue)}\nStaff ${fmtGBP(m.staffCost)}\nOH ${fmtGBP(m.overheads)}\nProfit ${fmtGBP(m.profit)}`}
                style={{ display: 'flex', alignItems: 'flex-end', gap: 1, justifyContent: 'center', height: '100%' }}>
                <div style={{ width: 5, height: rH, background: '#0e7fe0', borderRadius: '2px 2px 0 0' }} />
                <div style={{ display: 'flex', flexDirection: 'column-reverse', width: 5 }}>
                  <div style={{ height: sH, background: '#7c3aed', borderRadius: '0 0 0 0' }} />
                  <div style={{ height: oH, background: '#f59e0b', borderRadius: '2px 2px 0 0' }} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length}, 1fr)`, gap: 2, marginTop: 4 }}>
          {months.map((m) => (
            <div key={m.index} style={{ fontSize: 8, color: '#94a3b8', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
              {m.index % 3 === 0 ? m.label : ''}
            </div>
          ))}
        </div>
      </div>

      {/* Year summaries */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <YearCard label="Year 1" y={y1} />
        <YearCard label="Year 2" y={y2} />
      </div>

      {/* Monthly table */}
      <div style={{ marginTop: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a' }}>
          Month-by-month
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <th style={{ ...th, textAlign: 'left' }}>Month</th>
                <th style={th}>Revenue</th>
                <th style={th}>Staff</th>
                <th style={th}>Overheads</th>
                <th style={th}>Profit</th>
                <th style={th}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.index} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ ...td, textAlign: 'left', color: '#64748b' }}>{m.label}</td>
                  <td style={{ ...td, color: '#0e7fe0', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(m.revenue)}</td>
                  <td style={{ ...td, color: '#7c3aed', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(m.staffCost)}</td>
                  <td style={{ ...td, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(m.overheads)}</td>
                  <td style={{ ...td, color: m.profit >= 0 ? '#059669' : '#dc2626', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(m.profit)}</td>
                  <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{fmtPct(m.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Legend({ colour, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: colour }} />
      {label}
    </span>
  );
}

function YearCard({ label, y }) {
  const margin = y.revenue > 0 ? y.profit / y.revenue : 0;
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: 10 }}>{label}</div>
      <Row label="Revenue" v={fmtGBP(y.revenue)} />
      <Row label="Staff cost" v={fmtGBP(y.staffCost)} />
      <Row label="Overheads" v={fmtGBP(y.overheads)} />
      <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />
      <Row label="Profit" v={fmtGBP(y.profit)} bold colour={y.profit >= 0 ? '#059669' : '#dc2626'} />
      <Row label="Margin" v={fmtPct(margin)} />
    </div>
  );
}

function Row({ label, v, bold, colour }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: colour || '#0f172a', fontWeight: bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

const th = { padding: '10px 14px', textAlign: 'right', fontWeight: 600 };
const td = { padding: '8px 14px', textAlign: 'right', color: '#0f172a' };
