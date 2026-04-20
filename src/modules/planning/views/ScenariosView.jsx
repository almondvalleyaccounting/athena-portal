import React, { useEffect, useState } from 'react';
import { Trash2, Star, Copy } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { usePlanning } from '../PlanningModule';
import { buildProjection, fmtGBP, fmtPct } from '../lib/projection';

export default function ScenariosView() {
  const { scenarios, scenario, clientBillings, setActive, removeScenario, duplicateScenario, setScenarioId, updateScenario } = usePlanning();
  const [byScenario, setByScenario] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const ids = scenarios.map((s) => s.id);
      if (!ids.length) { setByScenario({}); setLoading(false); return; }
      const [{ data: staff }, { data: oh }, { data: owner }, { data: overrides }] = await Promise.all([
        supabase.from('plan_staff_lines').select('*').in('scenario_id', ids),
        supabase.from('plan_overhead_lines').select('*').in('scenario_id', ids),
        supabase.from('plan_owner_comp_lines').select('*').in('scenario_id', ids),
        supabase.from('plan_client_overrides').select('*').in('scenario_id', ids),
      ]);
      if (cancelled) return;
      const map = {};
      for (const s of scenarios) {
        map[s.id] = buildProjection({
          scenario: s,
          staffLines: (staff || []).filter((r) => r.scenario_id === s.id),
          overheadLines: (oh || []).filter((r) => r.scenario_id === s.id),
          ownerCompLines: (owner || []).filter((r) => r.scenario_id === s.id),
          clientOverrides: (overrides || []).filter((r) => r.scenario_id === s.id),
          clientBillings,
          horizonMonths: 24,
        });
      }
      setByScenario(map);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [scenarios, clientBillings]);

  return (
    <div>
      <div style={card}>
        <h3 style={h3}>Scenario comparison</h3>
        <p style={help}>Side-by-side view of every saved scenario. Click a column to make it the active scenario driving the rest of the dashboard.</p>

        {loading && <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>}

        {!loading && scenarios.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', minWidth: Math.max(600, 180 + scenarios.length * 160) }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 200 }}></th>
                  {scenarios.map((s) => (
                    <th key={s.id} style={{ ...th, textAlign: 'center', background: s.is_active ? '#eff6ff' : '#fff' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, color: '#0f172a', fontSize: 13 }}>
                          {s.is_active && <Star size={12} style={{ color: '#f59e0b', fill: '#f59e0b' }} />}
                          {s.name}
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {!s.is_active && (
                            <button onClick={() => setActive(s.id)} style={btnSm}>Activate</button>
                          )}
                          <button onClick={async () => {
                            const newId = await duplicateScenario(s.id, `${s.name} copy`);
                            setScenarioId(newId);
                          }} style={btnSmOutline} title="Duplicate">
                            <Copy size={11} />
                          </button>
                          {scenarios.length > 1 && (
                            <button onClick={() => { if (window.confirm(`Delete "${s.name}"?`)) removeScenario(s.id); }}
                              style={btnSmOutline} title="Delete"><Trash2 size={11} /></button>
                          )}
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <GroupRow label="Assumptions" />
                <Row label="Fee uplift %" scenarios={scenarios} render={(s) => `${s.fee_uplift_pct}%`} />
                <Row label="Churn %" scenarios={scenarios} render={(s) => `${s.churn_pct_annual}%`} />
                <Row label="New MRR £/mo" scenarios={scenarios} render={(s) => fmtGBP(s.new_mrr_per_month)} />
                <Row label="Ad-hoc %" scenarios={scenarios} render={(s) => `${s.ad_hoc_pct_of_recurring}%`} />
                <Row label="Pay rise %" scenarios={scenarios} render={(s) => `${s.pay_rise_pct}%`} />
                <Row label="OH inflator %" scenarios={scenarios} render={(s) => `${s.overhead_inflator_pct}%`} />

                <GroupRow label="Year 1" />
                <Row label="Revenue" scenarios={scenarios} highlight render={(s) => fmtGBP(byScenario[s.id]?.y1.revenue || 0)} />
                <Row label="Staff cost" scenarios={scenarios} render={(s) => fmtGBP(byScenario[s.id]?.y1.staffCost || 0)} />
                <Row label="Overheads" scenarios={scenarios} render={(s) => fmtGBP(byScenario[s.id]?.y1.overheads || 0)} />
                <Row label="Owner comp" scenarios={scenarios} render={(s) => fmtGBP(byScenario[s.id]?.y1.ownerComp || 0)} />
                <Row label="EBITDA" scenarios={scenarios} bold render={(s) => {
                  const v = byScenario[s.id]?.y1.ebitda || 0;
                  return <span style={{ color: v >= 0 ? '#059669' : '#dc2626' }}>{fmtGBP(v)}</span>;
                }} />
                <Row label="EBITDA margin" scenarios={scenarios} render={(s) => fmtPct(byScenario[s.id]?.y1.margin || 0)} />
                <Row label="Profit after owner" scenarios={scenarios} bold render={(s) => {
                  const v = byScenario[s.id]?.y1.profit || 0;
                  return <span style={{ color: v >= 0 ? '#0f172a' : '#dc2626' }}>{fmtGBP(v)}</span>;
                }} />

                <GroupRow label="Year 2" />
                <Row label="Revenue" scenarios={scenarios} highlight render={(s) => fmtGBP(byScenario[s.id]?.y2.revenue || 0)} />
                <Row label="EBITDA" scenarios={scenarios} bold render={(s) => {
                  const v = byScenario[s.id]?.y2.ebitda || 0;
                  return <span style={{ color: v >= 0 ? '#059669' : '#dc2626' }}>{fmtGBP(v)}</span>;
                }} />
                <Row label="EBITDA margin" scenarios={scenarios} render={(s) => fmtPct(byScenario[s.id]?.y2.margin || 0)} />
                <Row label="Profit after owner" scenarios={scenarios} bold render={(s) => {
                  const v = byScenario[s.id]?.y2.profit || 0;
                  return <span style={{ color: v >= 0 ? '#0f172a' : '#dc2626' }}>{fmtGBP(v)}</span>;
                }} />
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Notes on active scenario */}
      {scenario && (
        <div style={{ ...card, marginTop: 16 }}>
          <h3 style={h3}>Active scenario — {scenario.name}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
            <Field label="Name">
              <BlurInput value={scenario.name} onChange={(v) => updateScenario({ name: v })} />
            </Field>
            <Field label="Projection start">
              <input type="month" value={scenario.start_month?.slice(0, 7) || ''}
                onChange={(e) => updateScenario({ start_month: e.target.value ? e.target.value + '-01' : null })}
                style={inputStyle} />
            </Field>
            <Field label="Fee uplift anniversary month">
              <select value={scenario.fee_uplift_month} onChange={(e) => updateScenario({ fee_uplift_month: parseInt(e.target.value) })} style={inputStyle}>
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            <Field label="Pay rise month">
              <select value={scenario.pay_rise_month} onChange={(e) => updateScenario({ pay_rise_month: parseInt(e.target.value) })} style={inputStyle}>
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            <div style={{ gridColumn: 'span 2' }}>
              <Field label="Notes">
                <BlurTextarea value={scenario.notes || ''} onChange={(v) => updateScenario({ notes: v })} />
              </Field>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupRow({ label }) {
  return (
    <tr>
      <td colSpan={99} style={{ padding: '12px 12px 4px', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.7, borderTop: '1px solid #e5e7eb' }}>
        {label}
      </td>
    </tr>
  );
}

function Row({ label, scenarios, render, bold, highlight }) {
  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={{ ...td, color: '#64748b', fontSize: 12 }}>{label}</td>
      {scenarios.map((s) => (
        <td key={s.id} style={{
          ...td, textAlign: 'center', fontWeight: bold ? 700 : 500,
          fontVariantNumeric: 'tabular-nums',
          background: s.is_active ? '#eff6ff' : (highlight ? '#fafbfc' : undefined),
          color: '#0f172a',
        }}>
          {render(s)}
        </td>
      ))}
    </tr>
  );
}

function BlurInput({ value, onChange }) {
  const [v, setV] = useState(value || '');
  React.useEffect(() => setV(value || ''), [value]);
  return <input value={v} onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v !== (value || '')) onChange(v); }} style={inputStyle} />;
}
function BlurTextarea({ value, onChange }) {
  const [v, setV] = useState(value || '');
  React.useEffect(() => setV(value || ''), [value]);
  return <textarea value={v} rows={3} onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v !== (value || '')) onChange(v); }}
    style={{ ...inputStyle, resize: 'vertical', fontFamily: "'Outfit', sans-serif" }} />;
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const btnSm = { padding: '4px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif", background: '#0f172a', color: '#fff', border: 'none' };
const btnSmOutline = { padding: '4px 8px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif", background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', display: 'inline-flex', alignItems: 'center' };
