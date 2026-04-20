import React, { useState } from 'react';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { fmtGBP } from '../lib/projection';

export default function OverheadsView() {
  const { overheadLines, upsertOverhead, removeOverhead, pullQboPL } = usePlanning();
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState(null);

  const totalMonthly = overheadLines.reduce((s, o) => s + (Number(o.monthly_amount) || 0), 0);
  const totalAnnual = totalMonthly * 12;

  const handlePull = async () => {
    setPulling(true); setPullMsg(null);
    try {
      const r = await pullQboPL();
      if (r.success) setPullMsg(`Pulled ${r.expenses.length} expense accounts (${r.period.start} to ${r.period.end})`);
      else setPullMsg(`Error: ${r.error}`);
    } catch (e) { setPullMsg(`Error: ${e.message}`); }
    setPulling(false);
    setTimeout(() => setPullMsg(null), 6000);
  };

  const addBlank = async () => {
    await upsertOverhead({
      category: 'New overhead',
      monthly_amount: 0,
      sort_order: overheadLines.length,
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Overheads</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
            {fmtGBP(totalMonthly)}/mo <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b' }}>· {fmtGBP(totalAnnual)}/yr</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handlePull} disabled={pulling} style={{ ...btnOutline, opacity: pulling ? 0.5 : 1 }}>
            <RefreshCw size={14} /> {pulling ? 'Pulling…' : 'Refresh from QBO'}
          </button>
          <button onClick={addBlank} style={btnPrimary}><Plus size={14} /> Add line</button>
        </div>
      </div>

      {pullMsg && (
        <div style={{ background: '#eff6ff', color: '#0e7fe0', fontSize: 12, padding: '8px 12px', borderRadius: 8, marginBottom: 10 }}>{pullMsg}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Category</th>
              <th style={{ ...th, textAlign: 'right' }}>Monthly forecast</th>
              <th style={{ ...th, textAlign: 'right' }}>Annual forecast</th>
              <th style={{ ...th, textAlign: 'right' }}>QBO LTM actual</th>
              <th style={{ ...th, textAlign: 'right' }}>LTM vs forecast</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overheadLines.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                No overhead lines. Click "Refresh from QBO" to seed from the last 12 months of actuals.
              </td></tr>
            )}
            {overheadLines.map((line) => {
              const annualForecast = (Number(line.monthly_amount) || 0) * 12;
              const ltm = Number(line.qbo_actual_ltm) || 0;
              const delta = annualForecast - ltm;
              const deltaPct = ltm > 0 ? delta / ltm : 0;
              return (
                <tr key={line.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    <InlineInput value={line.category} onChange={(v) => upsertOverhead({ ...line, category: v })} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <InlineNumber value={line.monthly_amount} onChange={(v) => upsertOverhead({ ...line, monthly_amount: v || 0 })} />
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#64748b' }}>{fmtGBP(annualForecast)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#64748b' }}>{line.qbo_actual_ltm != null ? fmtGBP(ltm) : '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: delta === 0 ? '#64748b' : delta > 0 ? '#f59e0b' : '#059669' }}>
                    {line.qbo_actual_ltm != null ? `${delta >= 0 ? '+' : ''}${fmtGBP(delta)} (${(deltaPct * 100).toFixed(0)}%)` : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => { if (window.confirm(`Remove ${line.category}?`)) removeOverhead(line.id); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                      <Trash2 size={14} style={{ color: '#cbd5e1' }} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {overheadLines.length > 0 && (
            <tfoot>
              <tr style={{ background: '#f8fafc', fontWeight: 700 }}>
                <td style={td}>Total</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(totalMonthly)}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtGBP(totalAnnual)}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtGBP(overheadLines.reduce((s, o) => s + (Number(o.qbo_actual_ltm) || 0), 0))}
                </td>
                <td /><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function InlineInput({ value, onChange }) {
  const [v, setV] = useState(value);
  React.useEffect(() => setV(value), [value]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onChange(v); }} style={inputStyle} />
  );
}
function InlineNumber({ value, onChange }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  React.useEffect(() => setV(value == null ? '' : String(value)), [value]);
  return (
    <input type="number" step="0.01" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const parsed = v === '' ? 0 : parseFloat(v);
        if (parsed === Number(value)) return;
        onChange(parsed);
      }}
      style={{ ...inputStyle, textAlign: 'right' }} />
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '6px 8px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
