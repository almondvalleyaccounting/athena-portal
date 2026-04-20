import React, { useState, useMemo } from 'react';
import { AlertTriangle, CalendarX, Search, Flag } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { fmtGBP, fmtPct, detectWindDown } from '../lib/projection';

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const STATUS_META = {
  active:  { label: 'Active',   colour: '#059669', bg: '#f0fdf4' },
  at_risk: { label: 'At risk',  colour: '#dc2626', bg: '#fef2f2' },
  ending:  { label: 'Ending',   colour: '#f59e0b', bg: '#fffbeb' },
};

export default function RevenueView() {
  const { clientBillings, clientOverrides, upsertClientOverride, scenario, updateScenario } = usePlanning();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  // Merge billings + overrides, and detect wind-down signals from services JSONB.
  const book = useMemo(() => {
    const byId = new Map(clientOverrides.map((o) => [o.live_billing_id, o]));
    return clientBillings.map((b) => {
      const ov = byId.get(b.id);
      const windDown = detectWindDown(b.services);
      return {
        ...b,
        override: ov || null,
        status: ov?.status || 'active',
        endMonth: ov?.end_month || null,
        fee: ov?.fee_override_monthly != null ? Number(ov.fee_override_monthly) : b.monthly_net,
        notes: ov?.risk_notes || '',
        excludeUplift: !!ov?.exclude_from_uplift,
        windDown,
      };
    }).sort((a, b) => b.fee - a.fee);
  }, [clientBillings, clientOverrides]);

  const needsReview = useMemo(
    () => book.filter((c) => c.windDown && c.status === 'active' && !c.endMonth),
    [book]
  );

  const filtered = useMemo(() => {
    let list = book;
    if (filter !== 'all') list = list.filter((c) => c.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => (c.entity_name || '').toLowerCase().includes(q));
    }
    return list;
  }, [book, filter, search]);

  const totals = useMemo(() => {
    const t = { all: 0, active: 0, at_risk: 0, ending: 0 };
    for (const c of book) { t.all += c.fee; t[c.status] = (t[c.status] || 0) + c.fee; }
    return t;
  }, [book]);

  const count = useMemo(() => {
    const c = { all: book.length, active: 0, at_risk: 0, ending: 0 };
    for (const b of book) c[b.status] = (c[b.status] || 0) + 1;
    return c;
  }, [book]);

  const applyOverride = async (client, patch) => {
    await upsertClientOverride({
      id: client.override?.id,
      live_billing_id: client.id,
      entity_id: client.entity_id,
      status: client.status,
      end_month: client.endMonth,
      fee_override_monthly: client.override?.fee_override_monthly ?? null,
      exclude_from_uplift: client.excludeUplift,
      risk_notes: client.notes,
      ...patch,
    });
  };

  return (
    <div>
      {/* Scenario-level revenue assumptions */}
      <div style={card}>
        <h3 style={h3}>Revenue assumptions</h3>
        <p style={help}>These apply practice-wide. Client-level overrides below take precedence.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <SliderField label="Fee uplift %" min={0} max={25} step={0.5} suffix="%"
            value={scenario?.fee_uplift_pct || 0} onChange={(v) => updateScenario({ fee_uplift_pct: v })} />
          <SliderField label="Annual churn %" min={0} max={25} step={0.25} suffix="%"
            value={scenario?.churn_pct_annual || 0} onChange={(v) => updateScenario({ churn_pct_annual: v })} />
          <Field label="New MRR / month (£)">
            <input type="number" value={scenario?.new_mrr_per_month || 0}
              onChange={(e) => updateScenario({ new_mrr_per_month: parseFloat(e.target.value) || 0 })}
              style={inputStyle} />
          </Field>
          <SliderField label="Ad-hoc / one-off %" min={0} max={30} step={0.5} suffix="%"
            value={scenario?.ad_hoc_pct_of_recurring || 0} onChange={(v) => updateScenario({ ad_hoc_pct_of_recurring: v })} />
        </div>
      </div>

      {/* Seasonality */}
      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={h3}>Monthly seasonality</h3>
          <select value={scenario?.seasonality_applies_to || 'adhoc'}
            onChange={(e) => updateScenario({ seasonality_applies_to: e.target.value })}
            style={{ ...inputStyle, width: 'auto' }}>
            <option value="adhoc">Apply to ad-hoc only</option>
            <option value="all">Apply to all revenue</option>
          </select>
        </div>
        <p style={help}>
          Multipliers are normalised so they average 1 across the year — changing shape doesn't change total. Set {'>'}1 for peak months (SA rush, year-end) and {'<'}1 for lull months.
        </p>
        <SeasonalityEditor
          values={scenario?.seasonality_monthly_mult || [1,1,1,1,1,1,1,1,1,1,1,1]}
          onChange={(arr) => updateScenario({ seasonality_monthly_mult: arr })}
        />
      </div>

      {/* Wind-down signals — clients that look like they're winding down */}
      {needsReview.length > 0 && (
        <div style={{ ...card, marginTop: 16, borderColor: '#fde68a', background: '#fffbeb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Flag size={16} style={{ color: '#d97706' }} />
            <h3 style={{ ...h3, margin: 0 }}>Wind-down signals ({needsReview.length})</h3>
          </div>
          <p style={{ ...help, marginBottom: 10 }}>
            Detected from service descriptions — these clients may be one-offs tagged as recurring, or clients genuinely winding down (e.g. "6 months final payroll", "review for cancellation", "towards final accounts"). Set a status or end-month so the forecast doesn't assume they'll keep paying forever.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {needsReview.slice(0, 8).map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px solid #fde68a' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#0f172a' }}>{c.entity_name}</div>
                  <div style={{ fontSize: 11, color: '#92400e', marginTop: 2 }}>
                    {c.windDown.slice(0, 2).map((w, i) => <span key={i}>"{w.text.slice(0, 80)}{w.text.length > 80 ? '…' : ''}"{i < Math.min(1, c.windDown.length - 1) ? ' · ' : ''}</span>)}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', minWidth: 80, textAlign: 'right' }}>
                  {fmtGBP(c.fee)}/mo
                </div>
                <button onClick={() => applyOverride(c, { status: 'at_risk' })} style={btnMini}>Flag at risk</button>
                <button onClick={() => applyOverride(c, { status: 'ending', end_month: defaultEndMonth() })} style={btnMiniDark}>Ending in 6mo</button>
              </div>
            ))}
            {needsReview.length > 8 && <div style={{ fontSize: 11, color: '#92400e' }}>…and {needsReview.length - 8} more — work through them below.</div>}
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, margin: '16px 0' }}>
        <Summary label="Active book" colour="#059669" mo={totals.active} count={count.active} />
        <Summary label="At risk"      colour="#dc2626" mo={totals.at_risk} count={count.at_risk} />
        <Summary label="Ending"       colour="#f59e0b" mo={totals.ending} count={count.ending} />
        <Summary label="Total MRR"    colour="#0e7fe0" mo={totals.all} count={count.all} bold />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#cbd5e1' }} />
          <input placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb' }}>
          {['all','active','at_risk','ending'].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '6px 12px', fontSize: 12, fontWeight: filter === f ? 600 : 400,
              color: filter === f ? '#0f172a' : '#94a3b8',
              background: 'none', border: 'none', borderBottom: filter === f ? '2px solid #0e7fe0' : '2px solid transparent',
              cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
            }}>
              {f === 'all' ? 'All' : STATUS_META[f].label} ({count[f]})
            </button>
          ))}
        </div>
      </div>

      {/* Client table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Client</th>
              <th style={{ ...th, textAlign: 'right' }}>Monthly £</th>
              <th style={{ ...th, textAlign: 'right' }}>Annual £</th>
              <th style={th}>Status</th>
              <th style={th}>End month</th>
              <th style={th}>No uplift</th>
              <th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>No clients match.</td></tr>
            )}
            {filtered.map((c) => {
              const sm = STATUS_META[c.status];
              return (
                <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {c.status === 'at_risk' && <AlertTriangle size={12} style={{ color: '#dc2626' }} />}
                      {c.status === 'ending' && <CalendarX size={12} style={{ color: '#f59e0b' }} />}
                      <span style={{ color: '#0f172a', fontWeight: 500 }}>{c.entity_name}</span>
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(c.fee)}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(c.fee * 12)}</td>
                  <td style={td}>
                    <select value={c.status} onChange={(e) => applyOverride(c, { status: e.target.value })}
                      style={{ ...inputStyle, color: sm.colour, fontWeight: 500, background: sm.bg, border: `1px solid ${sm.colour}33` }}>
                      <option value="active">Active</option>
                      <option value="at_risk">At risk</option>
                      <option value="ending">Ending</option>
                    </select>
                  </td>
                  <td style={td}>
                    <input type="month" value={c.endMonth ? String(c.endMonth).slice(0, 7) : ''}
                      onChange={(e) => applyOverride(c, { end_month: e.target.value ? e.target.value + '-01' : null })}
                      style={inputStyle} />
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" checked={c.excludeUplift}
                      onChange={(e) => applyOverride(c, { exclude_from_uplift: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ ...td, minWidth: 180 }}>
                    <BlurInput value={c.notes} onChange={(v) => applyOverride(c, { risk_notes: v })} placeholder="Notes…" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlurInput({ value, onChange, placeholder }) {
  const [v, setV] = useState(value || '');
  React.useEffect(() => setV(value || ''), [value]);
  return (
    <input value={v} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || '')) onChange(v); }}
      style={inputStyle} />
  );
}

function defaultEndMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 6);
  return d.toISOString().slice(0, 7) + '-01';
}

function SeasonalityEditor({ values, onChange }) {
  const arr = Array.isArray(values) && values.length === 12 ? values.map(Number) : Array(12).fill(1);
  const setAt = (i, v) => {
    const next = arr.slice();
    next[i] = Math.max(0, Math.min(3, v));
    onChange(next);
  };
  const presets = [
    { label: 'Flat', values: Array(12).fill(1) },
    { label: 'UK practice (SA + year-end)', values: [1.4, 1.1, 1.1, 1.3, 1.0, 0.85, 0.75, 0.8, 1.0, 1.05, 1.05, 1.0] },
    { label: 'Year-end heavy (Apr)', values: [0.9, 0.9, 1.2, 1.4, 1.2, 0.9, 0.85, 0.85, 0.95, 1.0, 1.0, 0.85] },
    { label: 'SA-heavy (Jan)', values: [1.6, 1.1, 0.95, 1.0, 0.95, 0.9, 0.85, 0.85, 0.95, 1.0, 1.0, 0.95] },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center' }}>Presets:</span>
        {presets.map((p) => (
          <button key={p.label} onClick={() => onChange(p.values)} style={btnMini}>{p.label}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 6, alignItems: 'end' }}>
        {arr.map((v, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ position: 'relative', height: 60, width: '100%', background: '#f8fafc', borderRadius: 4, display: 'flex', alignItems: 'flex-end' }}>
              <div style={{ width: '100%', height: `${Math.min(100, v * 50)}%`, background: v >= 1 ? '#0e7fe0' : '#cbd5e1', borderRadius: '4px 4px 0 0' }} />
            </div>
            <input type="number" min={0} max={3} step={0.05} value={v}
              onChange={(e) => setAt(i, parseFloat(e.target.value) || 0)}
              style={{ ...inputStyle, fontSize: 11, padding: '4px 6px', textAlign: 'center' }} />
            <div style={{ fontSize: 10, color: '#94a3b8' }}>{MONTHS_SHORT[i]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Summary({ label, colour, mo, count, bold }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 14px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: bold ? 20 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{fmtGBP(mo * 12)}/yr</div>
      <div style={{ fontSize: 11, color: '#64748b' }}>{fmtGBP(mo)}/mo · {count} client{count !== 1 ? 's' : ''}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

function SliderField({ label, min, max, step, suffix, value, onChange }) {
  return (
    <Field label={label}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="range" min={min} max={max} step={step} value={value || 0}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ flex: 1, accentColor: '#0e7fe0' }} />
        <div style={{ minWidth: 60, display: 'flex', gap: 3, alignItems: 'center' }}>
          <input type="number" step={step} value={value || 0}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            style={{ ...inputStyle, width: 50, textAlign: 'right', padding: '6px 4px' }} />
          <span style={{ fontSize: 12, color: '#64748b' }}>{suffix}</span>
        </div>
      </div>
    </Field>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const btnMini = { padding: '4px 10px', fontSize: 11, fontWeight: 500, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const btnMiniDark = { padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
