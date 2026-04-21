import React, { useEffect, useMemo, useState } from 'react';
import { Trash2, Star, Copy, Target, TrendingUp } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { usePlanning } from '../PlanningModule';
import { buildProjection, fmtGBP, fmtGBPSigned, fmtPct } from '../lib/projection';

export default function ScenariosView() {
  const { scenarios, scenario, clientBillings, clientOverrides, staffLines, overheadLines, ownerCompLines, monthlyActuals, setActive, removeScenario, duplicateScenario, setScenarioId, updateScenario, projection } = usePlanning();
  const [byScenario, setByScenario] = useState({});
  const [loading, setLoading] = useState(true);

  // ── Goal-seek state
  const [goalProfit, setGoalProfit] = useState(200000);
  const [goalLever, setGoalLever] = useState('fee_uplift_pct');

  // ── Sensitivity tornado (±10% on each lever)
  const tornado = useMemo(() => {
    if (!scenario) return [];
    const levers = [
      { key: 'fee_uplift_pct', label: 'Fee uplift %', delta: 10 },
      { key: 'pay_rise_pct', label: 'Pay rise %', delta: 10 },
      { key: 'churn_pct_annual', label: 'Churn %', delta: 10 },
      { key: 'new_mrr_per_month', label: 'New MRR/mo', delta: 10 },
      { key: 'ad_hoc_pct_of_recurring', label: 'Ad-hoc %', delta: 10 },
      { key: 'overhead_inflator_pct', label: 'Overhead inflator %', delta: 10 },
    ];
    const base = projection.y2.profit;
    return levers.map((l) => {
      const baseVal = Number(scenario[l.key]) || 0;
      const up = baseVal * (1 + l.delta / 100);
      const down = baseVal * (1 - l.delta / 100);
      const upProj = buildProjection({
        scenario: { ...scenario, [l.key]: up },
        staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, horizonMonths: 24,
      });
      const downProj = buildProjection({
        scenario: { ...scenario, [l.key]: down },
        staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, horizonMonths: 24,
      });
      return {
        label: l.label,
        baseVal,
        upDelta: upProj.y2.profit - base,
        downDelta: downProj.y2.profit - base,
        absImpact: Math.max(Math.abs(upProj.y2.profit - base), Math.abs(downProj.y2.profit - base)),
      };
    }).sort((a, b) => b.absImpact - a.absImpact);
  }, [scenario, staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, projection]);

  // ── Goal-seek: bisect on lever to hit target profit
  const goalSeekResult = useMemo(() => {
    if (!scenario) return null;
    const base = projection.y2.profit;
    if (base >= goalProfit) return { already: true, base, target: goalProfit };

    // Bisect between 0 and 50 (or -50..50 for overhead-inflator etc)
    let lo = 0, hi = 50;
    if (goalLever === 'churn_pct_annual' || goalLever === 'pay_rise_pct' || goalLever === 'overhead_inflator_pct') {
      // Reducing these helps — search 0..current val
      lo = 0;
      hi = Number(scenario[goalLever]) || 5;
    }

    let tries = 0;
    let mid;
    while (tries++ < 30) {
      mid = (lo + hi) / 2;
      const p = buildProjection({
        scenario: { ...scenario, [goalLever]: mid },
        staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, horizonMonths: 24,
      }).y2.profit;
      const helpsUp = ['fee_uplift_pct', 'new_mrr_per_month', 'ad_hoc_pct_of_recurring'].includes(goalLever);
      if (helpsUp) {
        if (p < goalProfit) lo = mid; else hi = mid;
      } else {
        if (p > goalProfit) lo = mid; else hi = mid;
      }
      if (Math.abs(p - goalProfit) < 100) break;
    }
    return { already: false, base, target: goalProfit, leverValue: mid, currentLever: Number(scenario[goalLever]) || 0 };
  }, [scenario, goalProfit, goalLever, staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, projection]);

  const tornadoMax = Math.max(...tornado.map((t) => t.absImpact), 1);

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

      {/* Goal-seek + tornado */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Target size={16} style={{ color: '#0e7fe0' }} />
            <h3 style={{ ...h3, margin: 0 }}>Goal-seek</h3>
          </div>
          <p style={help}>
            What lever value hits a target Y2 profit? Solves by iteration on the scenario you've picked.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Target Y2 profit £</label>
              <input type="number" step="1000" value={goalProfit}
                onChange={(e) => setGoalProfit(parseFloat(e.target.value) || 0)}
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Solve for</label>
              <select value={goalLever} onChange={(e) => setGoalLever(e.target.value)} style={inputStyle}>
                <option value="fee_uplift_pct">Fee uplift %</option>
                <option value="new_mrr_per_month">New MRR £/mo</option>
                <option value="ad_hoc_pct_of_recurring">Ad-hoc %</option>
                <option value="churn_pct_annual">Churn % (lower)</option>
                <option value="pay_rise_pct">Pay rise % (lower)</option>
                <option value="overhead_inflator_pct">OH inflator % (lower)</option>
              </select>
            </div>
          </div>
          {goalSeekResult && (
            <div style={{ background: goalSeekResult.already ? '#f0fdf4' : '#eff6ff', border: `1px solid ${goalSeekResult.already ? '#bbf7d0' : '#bfdbfe'}`, padding: '10px 14px', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>Current Y2 profit</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{fmtGBP(goalSeekResult.base)}</div>
              {goalSeekResult.already ? (
                <div style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>✓ Already at or above target</div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>To hit target, set</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#0e7fe0' }}>
                    {goalLever.includes('mrr') ? fmtGBP(goalSeekResult.leverValue) + '/mo' : `${goalSeekResult.leverValue.toFixed(2)}%`}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    Currently {goalLever.includes('mrr') ? fmtGBP(goalSeekResult.currentLever) : `${goalSeekResult.currentLever.toFixed(2)}%`}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <TrendingUp size={16} style={{ color: '#7c3aed' }} />
            <h3 style={{ ...h3, margin: 0 }}>Sensitivity tornado (Y2 profit)</h3>
          </div>
          <p style={help}>
            Each lever ±10% — ranked by profit impact. The highest bar is the assumption that moves your plan the most. Focus your accuracy effort there.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tornado.map((t) => {
              const downPct = Math.abs(t.downDelta) / tornadoMax;
              const upPct = Math.abs(t.upDelta) / tornadoMax;
              return (
                <div key={t.label} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 100px', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <div style={{ fontWeight: 500, color: '#0f172a' }}>{t.label}</div>
                  <div style={{ position: 'relative', height: 14, display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ width: `${downPct * 100}%`, height: 14, background: t.downDelta < 0 ? '#dc2626' : '#059669', opacity: 0.7 }} />
                  </div>
                  <div style={{ position: 'relative', height: 14 }}>
                    <div style={{ width: `${upPct * 100}%`, height: 14, background: t.upDelta > 0 ? '#059669' : '#dc2626', opacity: 0.7 }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtGBPSigned(t.absImpact)}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 100px', gap: 8, fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
            <div />
            <div style={{ textAlign: 'right' }}>−10%</div>
            <div>+10%</div>
            <div />
          </div>
        </div>
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
const labelStyle = { fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 };
