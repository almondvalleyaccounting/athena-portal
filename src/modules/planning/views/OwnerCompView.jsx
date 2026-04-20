import React, { useState, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { usePlanning } from '../PlanningModule';
import { fmtGBP } from '../lib/projection';

const TYPES = [
  { value: 'salary',      label: 'Salary (PAYE)' },
  { value: 'dividend',    label: 'Dividend' },
  { value: 'home_office', label: 'Home office' },
  { value: 'mileage',     label: 'Mileage' },
  { value: 'pension',     label: 'Pension contribution' },
  { value: 'other',       label: 'Other expense' },
];

export default function OwnerCompView() {
  const { ownerCompLines, upsertOwnerComp, removeOwnerComp, scenario, projection } = usePlanning();
  const [ownerFilter, setOwnerFilter] = useState('all');

  const owners = useMemo(() => {
    const set = new Set(ownerCompLines.map((l) => l.owner_name).filter(Boolean));
    return Array.from(set);
  }, [ownerCompLines]);

  const filtered = ownerFilter === 'all' ? ownerCompLines : ownerCompLines.filter((l) => l.owner_name === ownerFilter);

  const y1Total = projection.y1.ownerComp;
  const y2Total = projection.y2.ownerComp;

  const add = async (preset) => {
    await upsertOwnerComp({
      owner_name: owners[0] || 'Owner',
      comp_type: preset || 'salary',
      amount_monthly: 0,
      apply_pay_rise: preset === 'salary',
      sort_order: ownerCompLines.length,
    });
  };

  const defaultOnCosts = Number(scenario?.default_on_costs_pct || 15.05);

  // Per-owner summary
  const byOwner = useMemo(() => {
    const map = {};
    for (const l of ownerCompLines) {
      const key = l.owner_name || '—';
      if (!map[key]) map[key] = { salary: 0, dividend: 0, other: 0, total: 0 };
      const annualSalary = (Number(l.amount_monthly) || 0) * 12;
      const annualDiv = l.amount_annual != null ? Number(l.amount_annual) : (Number(l.amount_monthly) || 0) * 12;
      if (l.comp_type === 'salary') {
        const on = l.on_costs_pct == null ? defaultOnCosts : Number(l.on_costs_pct);
        const fully = annualSalary * (1 + on / 100);
        map[key].salary += fully; map[key].total += fully;
      } else if (l.comp_type === 'dividend') {
        map[key].dividend += annualDiv; map[key].total += annualDiv;
      } else {
        map[key].other += annualSalary; map[key].total += annualSalary;
      }
    }
    return map;
  }, [ownerCompLines, defaultOnCosts]);

  return (
    <div>
      <div style={card}>
        <h3 style={h3}>Owner compensation</h3>
        <p style={help}>
          Director salaries, dividends, home-office costs, mileage and other personal-to-owner items. Kept separate from staff
          payroll so the practice shows <b>EBITDA (before owner comp)</b> — the number a buyer looks at — and
          <b> profit after owner comp</b> — what you actually take home.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <Summary label="Y1 owner comp" value={fmtGBP(y1Total)} />
          <Summary label="Y2 owner comp" value={fmtGBP(y2Total)} />
        </div>

        {/* By owner */}
        {Object.keys(byOwner).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>By owner (annualised)</div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Object.keys(byOwner).length)}, 1fr)`, gap: 10 }}>
              {Object.entries(byOwner).map(([owner, b]) => (
                <div key={owner} style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>{owner}</div>
                  <Row label="Salary (loaded)" v={fmtGBP(b.salary)} />
                  <Row label="Dividend" v={fmtGBP(b.dividend)} />
                  <Row label="Other" v={fmtGBP(b.other)} />
                  <div style={{ height: 1, background: '#e2e8f0', margin: '6px 0' }} />
                  <Row label="Total" v={fmtGBP(b.total)} bold />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 10px', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Owner</label>
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
            style={{ ...inputStyle, width: 'auto' }}>
            <option value="all">All</option>
            {owners.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {TYPES.map((t) => (
            <button key={t.value} onClick={() => add(t.value)} style={btnOutline}>
              <Plus size={12} /> {t.label.replace(' (PAYE)', '')}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Owner</th>
              <th style={th}>Type</th>
              <th style={{ ...th, textAlign: 'right' }}>Monthly £</th>
              <th style={{ ...th, textAlign: 'right' }}>Annual £ (div)</th>
              <th style={{ ...th, textAlign: 'right' }}>On-costs %</th>
              <th style={th}>Pay rise</th>
              <th style={th}>Start</th>
              <th style={th}>End</th>
              <th style={th}>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                No owner comp lines yet. Add a salary or dividend row above.
              </td></tr>
            )}
            {filtered.map((l) => {
              const isSalary = l.comp_type === 'salary';
              const isDividend = l.comp_type === 'dividend';
              return (
                <tr key={l.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}><BlurInput value={l.owner_name} onChange={(v) => upsertOwnerComp({ ...l, owner_name: v })} /></td>
                  <td style={td}>
                    <select value={l.comp_type} onChange={(e) => upsertOwnerComp({ ...l, comp_type: e.target.value })}
                      style={inputStyle}>
                      {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <BlurNumber value={l.amount_monthly} onChange={(v) => upsertOwnerComp({ ...l, amount_monthly: v })} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {isDividend
                      ? <BlurNumber value={l.amount_annual} onChange={(v) => upsertOwnerComp({ ...l, amount_annual: v })} />
                      : <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {isSalary
                      ? <BlurNumber value={l.on_costs_pct} placeholder={String(defaultOnCosts)}
                          onChange={(v) => upsertOwnerComp({ ...l, on_costs_pct: v === '' ? null : v })} />
                      : <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" checked={!!l.apply_pay_rise}
                      onChange={(e) => upsertOwnerComp({ ...l, apply_pay_rise: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={td}>
                    <input type="month" value={l.start_month ? String(l.start_month).slice(0, 7) : ''}
                      onChange={(e) => upsertOwnerComp({ ...l, start_month: e.target.value ? e.target.value + '-01' : null })}
                      style={inputStyle} />
                  </td>
                  <td style={td}>
                    <input type="month" value={l.end_month ? String(l.end_month).slice(0, 7) : ''}
                      onChange={(e) => upsertOwnerComp({ ...l, end_month: e.target.value ? e.target.value + '-01' : null })}
                      style={inputStyle} />
                  </td>
                  <td style={td}><BlurInput value={l.notes || ''} onChange={(v) => upsertOwnerComp({ ...l, notes: v })} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => { if (window.confirm('Remove line?')) removeOwnerComp(l.id); }}
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
        const parsed = v === '' ? '' : parseFloat(v);
        if (parsed === value) return;
        onChange(parsed);
      }}
      style={{ ...inputStyle, textAlign: 'right' }} />
  );
}

function Summary({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Row({ label, v, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#0f172a', fontWeight: bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14, lineHeight: 1.55 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
