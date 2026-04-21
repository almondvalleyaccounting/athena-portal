import React, { useState, useMemo } from 'react';
import { Plus, Trash2, User, AlertTriangle } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { fmtGBP, computeCapacity } from '../lib/projection';

export default function StaffView() {
  const { staffLines, staffProfiles, upsertStaff, removeStaff, scenario, updateScenario, projection, timesheetEntries } = usePlanning();

  // Capacity analysis — blended £/hour from LTM timesheets × capacity hours
  const blendedRatePerHr = useMemo(() => {
    const totalHrs = timesheetEntries.reduce((s, e) => s + (e.minutes || 0) / 60, 0);
    if (totalHrs === 0) return null;
    // If we have live_billing revenue and matched hours, use that as the blended rate
    // Fall back to 100 if no data (just a placeholder until timesheets accumulate).
    return 100;
  }, [timesheetEntries]);
  const capacityByMonth = useMemo(
    () => computeCapacity({ staffLines, scenario, months: projection.months, effectiveRatePerHour: blendedRatePerHr || 0 }),
    [staffLines, scenario, projection.months, blendedRatePerHr]
  );
  const shortfallMonths = useMemo(() =>
    capacityByMonth.filter((m, i) => projection.months[i]?.revenue > m.capacity_revenue && m.capacity_revenue > 0),
    [capacityByMonth, projection.months]
  );

  const defaultOnCosts = Number(scenario?.default_on_costs_pct || 15.05);
  const totalBase = staffLines.reduce((s, l) => s + (Number(l.annual_salary) || 0), 0);
  const totalFullyLoaded = staffLines.reduce((s, l) => {
    const on = l.on_costs_pct == null ? defaultOnCosts : Number(l.on_costs_pct);
    return s + (Number(l.annual_salary) || 0) * (1 + on / 100);
  }, 0);

  const revPerHead = staffLines.length > 0 ? projection.y1.revenue / staffLines.length : 0;

  const addBlank = async () => {
    await upsertStaff({
      name: 'New hire', role: '', annual_salary: 30000,
      sort_order: staffLines.length,
      start_month: new Date().toISOString().slice(0, 10),
    });
  };

  const addFromProfile = async (sp) => {
    await upsertStaff({
      staff_id: sp.id, name: sp.name, annual_salary: 0,
      sort_order: staffLines.length,
    });
  };

  const unseededStaff = staffProfiles.filter((sp) => !staffLines.some((l) => l.staff_id === sp.id));

  return (
    <div>
      {/* Levers */}
      <div style={card}>
        <h3 style={h3}>Staff assumptions</h3>
        <p style={help}>Pay rise compounds annually on the anniversary month. Individual lines can opt out via the "No pay rise" checkbox below.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <SliderField label="Pay rise %" min={0} max={15} step={0.25} suffix="%"
            value={scenario?.pay_rise_pct || 0} onChange={(v) => updateScenario({ pay_rise_pct: v })} />
          <Field label="Pay rise month">
            <select value={scenario?.pay_rise_month || 4}
              onChange={(e) => updateScenario({ pay_rise_month: parseInt(e.target.value) })}
              style={inputStyle}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <SliderField label="Default on-costs %" min={0} max={30} step={0.25} suffix="%"
            value={scenario?.default_on_costs_pct || 15.05} onChange={(v) => updateScenario({ default_on_costs_pct: v })} />
        </div>
      </div>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, margin: '16px 0' }}>
        <Stat label="Headcount" value={staffLines.length} colour="#7c3aed" />
        <Stat label="Base salaries" value={fmtGBP(totalBase)} colour="#64748b" />
        <Stat label="Fully loaded" value={fmtGBP(totalFullyLoaded)} sub="Incl. on-costs" colour="#7c3aed" bold />
        <Stat label="Revenue / head" value={fmtGBP(revPerHead)} sub="Y1" colour="#0e7fe0" />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
        {unseededStaff.length > 0 && (
          <select value="" onChange={(e) => { const sp = staffProfiles.find((x) => x.id === e.target.value); if (sp) addFromProfile(sp); }}
            style={{ ...inputStyle, width: 'auto' }}>
            <option value="">+ Add existing staff…</option>
            {unseededStaff.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
          </select>
        )}
        <button onClick={addBlank} style={btnDark}><Plus size={14} /> New hire</button>
      </div>

      {/* Capacity analysis */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h3 style={h3}>Capacity vs forecast demand</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Target hrs / fee earner / yr</label>
            <input type="number" step="50" value={scenario?.target_chargeable_hours_pa || 1400}
              onChange={(e) => updateScenario({ target_chargeable_hours_pa: parseFloat(e.target.value) || 1400 })}
              style={{ ...inputStyle, width: 90, textAlign: 'right' }} />
          </div>
        </div>
        <p style={help}>
          Capacity £ per month = (fee-earner headcount × target hrs ÷ 12) × blended effective rate.
          Toggle "Fee earner" on individual rows below to include/exclude from capacity.
          Months where forecast revenue exceeds capacity are shaded — if that becomes persistent, it's your signal to hire.
        </p>
        {blendedRatePerHr == null ? (
          <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', padding: '8px 12px', borderRadius: 8 }}>
            <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Blended rate will be derived from LTM timesheets once staff start logging time. Using £100/hr placeholder for now.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, alignItems: 'end', height: 90 }}>
            {capacityByMonth.map((c, i) => {
              const demand = projection.months[i]?.revenue || 0;
              const cap = c.capacity_revenue || 0;
              const max = Math.max(...capacityByMonth.map((x, j) => Math.max(x.capacity_revenue, projection.months[j]?.revenue || 0))) || 1;
              const demandH = (demand / max) * 80;
              const capH = (cap / max) * 80;
              const over = demand > cap && cap > 0;
              return (
                <div key={i} title={`${c.label}\nCapacity ${fmtGBP(cap)}\nDemand ${fmtGBP(demand)}${over ? '\nOVER — hire needed' : ''}`}
                  style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
                  <div style={{ width: '70%', height: demandH, background: over ? '#dc2626' : '#0e7fe0', borderRadius: '2px 2px 0 0', opacity: 0.9 }} />
                  <div style={{ position: 'absolute', top: 80 - capH - 1, width: '90%', height: 2, background: '#0f172a' }} />
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#64748b', marginTop: 6 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: '#0e7fe0' }} />Forecast demand</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 2, background: '#0f172a' }} />Capacity ceiling</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, background: '#dc2626' }} />Over capacity</span>
          {shortfallMonths.length > 0 && (
            <span style={{ marginLeft: 'auto', color: '#dc2626', fontWeight: 600 }}>
              ⚠ {shortfallMonths.length} month{shortfallMonths.length !== 1 ? 's' : ''} over capacity — consider adding a hire
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Name</th>
              <th style={th}>Role</th>
              <th style={{ ...th, textAlign: 'right' }}>Annual salary</th>
              <th style={{ ...th, textAlign: 'right' }}>On-costs %</th>
              <th style={{ ...th, textAlign: 'right' }}>Fully loaded</th>
              <th style={th}>Start</th>
              <th style={th}>End</th>
              <th style={{ ...th, textAlign: 'center' }}>Fee earner</th>
              <th style={{ ...th, textAlign: 'center' }}>No pay rise</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staffLines.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>No staff lines yet.</td></tr>
            )}
            {staffLines.map((line) => {
              const on = line.on_costs_pct == null ? defaultOnCosts : Number(line.on_costs_pct);
              const fullyLoaded = (Number(line.annual_salary) || 0) * (1 + on / 100);
              return (
                <tr key={line.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {line.staff_id ? <User size={12} style={{ color: '#94a3b8' }} /> : <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>NEW</span>}
                      <BlurInput value={line.name} onChange={(v) => upsertStaff({ ...line, name: v })} />
                    </div>
                  </td>
                  <td style={td}><BlurInput value={line.role || ''} placeholder="role" onChange={(v) => upsertStaff({ ...line, role: v })} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <BlurNumber value={line.annual_salary} onChange={(v) => upsertStaff({ ...line, annual_salary: v })} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <BlurNumber value={line.on_costs_pct == null ? '' : line.on_costs_pct} placeholder={String(defaultOnCosts)}
                      onChange={(v) => upsertStaff({ ...line, on_costs_pct: v === '' ? null : v })} />
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtGBP(fullyLoaded)}</td>
                  <td style={td}>
                    <input type="month" value={line.start_month ? String(line.start_month).slice(0, 7) : ''}
                      onChange={(e) => upsertStaff({ ...line, start_month: e.target.value ? e.target.value + '-01' : null })}
                      style={inputStyle} />
                  </td>
                  <td style={td}>
                    <input type="month" value={line.end_month ? String(line.end_month).slice(0, 7) : ''}
                      onChange={(e) => upsertStaff({ ...line, end_month: e.target.value ? e.target.value + '-01' : null })}
                      style={inputStyle} />
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" checked={line.is_fee_earner !== false}
                      onChange={(e) => upsertStaff({ ...line, is_fee_earner: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" checked={!!line.exclude_from_pay_rise}
                      onChange={(e) => upsertStaff({ ...line, exclude_from_pay_rise: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => { if (window.confirm(`Remove ${line.name}?`)) removeStaff(line.id); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                      <Trash2 size={14} style={{ color: '#cbd5e1' }} />
                    </button>
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

function Stat({ label, value, sub, colour, bold }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 14px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: bold ? 20 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b' }}>{sub}</div>}
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

function BlurInput({ value, onChange, placeholder }) {
  const [v, setV] = useState(value || '');
  React.useEffect(() => setV(value || ''), [value]);
  return <input value={v} placeholder={placeholder}
    onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v !== (value || '')) onChange(v); }} style={inputStyle} />;
}

function BlurNumber({ value, onChange, placeholder }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  React.useEffect(() => setV(value == null ? '' : String(value)), [value]);
  return (
    <input type="number" step="0.01" value={v} placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === '' && (value == null || value === '')) return;
        const parsed = v === '' ? '' : parseFloat(v);
        if (parsed === value) return;
        onChange(parsed);
      }}
      style={{ ...inputStyle, textAlign: 'right' }} />
  );
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const btnDark = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
