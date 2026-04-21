import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp, Clock } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { computeClientProfitability, fmtGBP, fmtPct } from '../lib/projection';
import { loadTimesheetLTM } from '../lib/queries';

// Per-client revenue ÷ cost-to-serve hitlist. Worst margins first.
// Cost-to-serve = sum over staff of (LTM hours × fully-loaded hourly rate).
// Hourly rate = annual fully-loaded ÷ max(target hours pa, actual LTM hours).

export default function ProfitabilityView() {
  const { clientBillings, clientOverrides, staffLines, staffProfiles, scenario, updateScenario } = usePlanning();
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const t = await loadTimesheetLTM();
        setTimesheets(t);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  const rows = useMemo(() => computeClientProfitability({
    clientBillings, clientOverrides, timesheetEntries: timesheets, staffLines, staffProfiles, scenario,
  }), [clientBillings, clientOverrides, timesheets, staffLines, staffProfiles, scenario]);

  const filtered = useMemo(() => {
    let list = rows;
    if (filter === 'loss') list = list.filter((r) => r.margin < 0);
    if (filter === 'low_margin') list = list.filter((r) => r.margin_pct < 0.3);
    if (filter === 'no_time') list = list.filter((r) => r.hours_ltm === 0);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => (r.entity_name || '').toLowerCase().includes(q));
    }
    return list;
  }, [rows, filter, search]);

  const totals = useMemo(() => {
    const t = { clients: rows.length, revenue: 0, cost: 0, hours: 0, at_loss: 0 };
    for (const r of rows) {
      t.revenue += r.annual_revenue;
      t.cost += r.cost_to_serve;
      t.hours += r.hours_ltm;
      if (r.margin < 0) t.at_loss += 1;
    }
    t.margin = t.revenue - t.cost;
    t.margin_pct = t.revenue > 0 ? t.margin / t.revenue : 0;
    t.blended_rate = t.hours > 0 ? t.revenue / t.hours : 0;
    return t;
  }, [rows]);

  const targetHours = Number(scenario?.target_chargeable_hours_pa) || 1400;

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={h3}>Client profitability</h3>
            <p style={help}>
              Revenue per client minus cost-to-serve, using last-12-months logged timesheets. Hourly cost per
              staff is <code>fully-loaded salary ÷ max(target hours, actual LTM hours)</code> — if someone
              over-delivers, their effective rate drops, and vice versa. Clients with no logged time cost nothing
              (by design) — they appear as 100% margin until someone records work against them.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Target hrs / fee earner / yr</label>
            <input type="number" step="50" value={targetHours}
              onChange={(e) => updateScenario({ target_chargeable_hours_pa: parseFloat(e.target.value) || 1400 })}
              style={{ ...inputStyle, width: 90, textAlign: 'right' }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginTop: 16 }}>
          <Stat label="Revenue (annual)" value={fmtGBP(totals.revenue)} colour="#0e7fe0" big />
          <Stat label="Cost to serve (LTM)" value={fmtGBP(totals.cost)} colour="#7c3aed" />
          <Stat label="Gross margin" value={fmtGBP(totals.margin)} sub={fmtPct(totals.margin_pct)} colour={totals.margin >= 0 ? '#059669' : '#dc2626'} big />
          <Stat label="Blended £/hour" value={fmtGBP(totals.blended_rate)} sub={`${totals.hours.toFixed(0)} hrs LTM`} colour="#64748b" />
          <Stat label="Clients at a loss" value={totals.at_loss} colour={totals.at_loss > 0 ? '#dc2626' : '#64748b'} />
        </div>

        {timesheets.length === 0 && !loading && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginTop: 16, fontSize: 12, color: '#92400e' }}>
            <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            No timesheet entries in LTM — profitability calc shows 100% margin for every client until staff start logging time.
          </div>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, margin: '16px 0 10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <input placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb' }}>
          {[
            { v: 'all', l: 'All', c: rows.length },
            { v: 'loss', l: 'At a loss', c: rows.filter((r) => r.margin < 0).length },
            { v: 'low_margin', l: '<30% margin', c: rows.filter((r) => r.margin_pct < 0.3).length },
            { v: 'no_time', l: 'No time logged', c: rows.filter((r) => r.hours_ltm === 0).length },
          ].map((t) => (
            <button key={t.v} onClick={() => setFilter(t.v)}
              style={{ padding: '6px 12px', fontSize: 12, fontWeight: filter === t.v ? 600 : 400, color: filter === t.v ? '#0f172a' : '#94a3b8', background: 'none', border: 'none', borderBottom: filter === t.v ? '2px solid #0e7fe0' : '2px solid transparent', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
              {t.l} ({t.c})
            </button>
          ))}
        </div>
      </div>

      {/* Hitlist table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Client</th>
              <th style={{ ...th, textAlign: 'right' }}>Annual £</th>
              <th style={{ ...th, textAlign: 'right' }}>Hrs LTM</th>
              <th style={{ ...th, textAlign: 'right' }}>Effective £/hr</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost to serve</th>
              <th style={{ ...th, textAlign: 'right' }}>Margin £</th>
              <th style={{ ...th, textAlign: 'right' }}>Margin %</th>
              <th style={th}>Main service</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading LTM timesheets…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>No clients match.</td></tr>}
            {filtered.map((r) => {
              const atLoss = r.margin < 0;
              const low = !atLoss && r.margin_pct < 0.3;
              return (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', background: atLoss ? '#fef2f2' : low ? '#fffbeb' : undefined }}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {atLoss && <TrendingDown size={12} style={{ color: '#dc2626' }} />}
                      {low && <AlertTriangle size={12} style={{ color: '#f59e0b' }} />}
                      <span style={{ fontWeight: 500 }}>{r.entity_name}</span>
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(r.annual_revenue)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.hours_ltm === 0 ? '#cbd5e1' : '#0f172a' }}>
                    {r.hours_ltm.toFixed(1)}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.hours_ltm > 0 ? fmtGBP(r.effective_rate) : '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#64748b' }}>{fmtGBP(r.cost_to_serve)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.margin >= 0 ? '#0f172a' : '#dc2626', fontWeight: 600 }}>{fmtGBP(r.margin)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.margin_pct >= 0.3 ? '#059669' : r.margin_pct >= 0 ? '#f59e0b' : '#dc2626', fontWeight: 700 }}>
                    {fmtPct(r.margin_pct)}
                  </td>
                  <td style={{ ...td, fontSize: 11, color: '#64748b' }}>{r.top_service || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, colour, big }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: big ? 20 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b' }}>{sub}</div>}
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 4, lineHeight: 1.55 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
