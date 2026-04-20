import React, { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { usePlanning } from '../PlanningModule';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default function AssumptionsView() {
  const { scenario, updateScenario, scenarios, removeScenario, setActive } = usePlanning();
  const [local, setLocal] = useState(scenario);

  useEffect(() => { setLocal(scenario); }, [scenario?.id, scenario?.updated_at]);

  if (!local) return null;

  const save = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    updateScenario(patch);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <section style={card}>
        <h3 style={h3}>Revenue levers</h3>
        <p style={help}>Models a practice-wide fee uplift applied once per year on the anniversary month. Compounds year on year.</p>
        <Field label="Fee uplift %">
          <Slider min={0} max={25} step={0.5} value={local.fee_uplift_pct} onChange={(v) => save({ fee_uplift_pct: v })} suffix="%" />
        </Field>
        <Field label="Uplift anniversary month">
          <select value={local.fee_uplift_month} onChange={(e) => save({ fee_uplift_month: parseInt(e.target.value) })} style={selectStyle}>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </Field>
      </section>

      <section style={card}>
        <h3 style={h3}>Staff levers</h3>
        <p style={help}>Pay rise applies to every staff line that isn't flagged "no pay rise". Compounds annually.</p>
        <Field label="Pay rise %">
          <Slider min={0} max={15} step={0.25} value={local.pay_rise_pct} onChange={(v) => save({ pay_rise_pct: v })} suffix="%" />
        </Field>
        <Field label="Pay rise month">
          <select value={local.pay_rise_month} onChange={(e) => save({ pay_rise_month: parseInt(e.target.value) })} style={selectStyle}>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </Field>
        <Field label="Default on-costs %">
          <Slider min={0} max={30} step={0.25} value={local.default_on_costs_pct} onChange={(v) => save({ default_on_costs_pct: v })} suffix="%" />
        </Field>
        <p style={{ ...help, fontSize: 11 }}>Employer NI + pension. Individual staff can override.</p>
      </section>

      <section style={{ ...card, gridColumn: 'span 2' }}>
        <h3 style={h3}>Scenario details</h3>
        <Field label="Name">
          <input value={local.name} onChange={(e) => save({ name: e.target.value })} style={inputStyle} />
        </Field>
        <Field label="Projection start">
          <input type="month" value={local.start_month?.slice(0, 7) || ''}
            onChange={(e) => save({ start_month: e.target.value ? e.target.value + '-01' : null })}
            style={inputStyle} />
        </Field>
        <Field label="Notes">
          <textarea value={local.notes || ''} onChange={(e) => save({ notes: e.target.value })}
            rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: "'Outfit', sans-serif" }} />
        </Field>
      </section>

      <section style={{ ...card, gridColumn: 'span 2' }}>
        <h3 style={h3}>All scenarios</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {scenarios.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: s.is_active ? '#eff6ff' : '#fff' }}>
              <div style={{ flex: 1, fontSize: 13, fontWeight: s.is_active ? 600 : 400, color: '#0f172a' }}>
                {s.name} {s.is_active && <span style={{ fontSize: 10, color: '#0e7fe0', marginLeft: 6 }}>ACTIVE</span>}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                Fee {s.fee_uplift_pct}% · Pay {s.pay_rise_pct}%
              </div>
              {!s.is_active && (
                <button onClick={() => setActive(s.id)} style={{ ...btnSm, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb' }}>Activate</button>
              )}
              {scenarios.length > 1 && (
                <button onClick={() => { if (window.confirm(`Delete scenario "${s.name}"?`)) removeScenario(s.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                  <Trash2 size={14} style={{ color: '#cbd5e1' }} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

function Slider({ min, max, step, value, onChange, suffix }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: '#0e7fe0' }} />
      <div style={{ minWidth: 70, display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="number" step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          style={{ ...inputStyle, width: 60, textAlign: 'right' }} />
        <span style={{ fontSize: 13, color: '#64748b' }}>{suffix}</span>
      </div>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14 };
const inputStyle = { width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const selectStyle = { ...inputStyle };
const btnSm = { padding: '4px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
