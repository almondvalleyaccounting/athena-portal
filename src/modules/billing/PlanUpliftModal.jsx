import React, { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const font = "'Outfit', sans-serif";

// Plan a fee uplift across a set of selected service lines. Stages
// the new amount as `pending_monthly_amount` + `pending_effective_at`
// on each service (jsonb on live_billing.services[idx]). Current
// monthly_amount is left untouched until the effective date — the
// pending values are how we'll roll out fee raises in June 2026 and
// still drive the accompanying client emails.
export default function PlanUpliftModal({ rows, selectedKeys, onClose, onApplied }) {
  const [strategy, setStrategy] = useState('inflation'); // inflation | floor | greater
  const [inflationPct, setInflationPct] = useState(5);
  const [roundUp, setRoundUp] = useState(true);
  const [floorAmount, setFloorAmount] = useState(50);
  const [effectiveAt, setEffectiveAt] = useState('2026-06-01');
  const [reason, setReason] = useState('Annual fee review 2026');
  const [applying, setApplying] = useState(false);

  // Resolve selected keys → concrete service rows with current amount.
  const targets = useMemo(() => {
    const list = [];
    for (const key of selectedKeys) {
      const [rowId, idxStr] = key.split('::');
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const idx = Number(idxStr);
      const s = row.services?.[idx];
      if (!s) continue;
      list.push({
        rowId,
        serviceIdx: idx,
        entityName: row.entity?.name || 'Unknown',
        serviceLabel: s.service_id || s.description || 'service',
        current: Number(s.monthly_amount) || 0,
        cadence: s.cadence || 'monthly',
      });
    }
    return list;
  }, [rows, selectedKeys]);

  const computeNew = (current) => {
    let out = current;
    const inflated = current * (1 + Number(inflationPct) / 100);
    const floor = Number(floorAmount);
    if (strategy === 'inflation') out = inflated;
    else if (strategy === 'floor') out = Math.max(current, floor);
    else if (strategy === 'greater') out = Math.max(inflated, floor);
    if (roundUp) out = Math.ceil(out * 2) / 2; // nearest £0.50 up
    return Math.round(out * 100) / 100;
  };

  const preview = useMemo(() => targets.map((t) => {
    const newAmt = computeNew(t.current);
    return { ...t, proposed: newAmt, delta: Math.round((newAmt - t.current) * 100) / 100 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [targets, strategy, inflationPct, roundUp, floorAmount]);

  const totals = useMemo(() => {
    const currMonthly = preview.filter((p) => p.cadence === 'monthly').reduce((s, p) => s + p.current, 0);
    const newMonthly = preview.filter((p) => p.cadence === 'monthly').reduce((s, p) => s + p.proposed, 0);
    const changed = preview.filter((p) => p.delta !== 0).length;
    return { currMonthly, newMonthly, changed, lineCount: preview.length };
  }, [preview]);

  const apply = async () => {
    if (preview.length === 0) return;
    if (!window.confirm(`Stage uplift on ${preview.length} service line(s)? Pending amounts take effect ${effectiveAt}.`)) return;
    setApplying(true);
    const byRow = {};
    for (const p of preview) (byRow[p.rowId] ||= []).push(p);
    for (const [rowId, items] of Object.entries(byRow)) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const services = [...(row.services || [])];
      for (const it of items) {
        const existing = services[it.serviceIdx] || {};
        if (it.delta === 0) continue; // skip no-ops
        services[it.serviceIdx] = {
          ...existing,
          pending_monthly_amount: it.proposed,
          pending_effective_at: effectiveAt,
          pending_uplift_reason: reason || null,
          pending_uplift_staged_at: new Date().toISOString(),
        };
      }
      await supabase.from('live_billing').update({
        services,
        uplift_review_status: 'staged',
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq('id', rowId);
    }
    setApplying(false);
    onApplied?.();
    onClose();
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: 0 }}>Plan fee uplift</h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 0 }}>
          {/* Strategy panel */}
          <div style={{ padding: 18, borderRight: '1px solid #e5e7eb', background: '#f8fafc' }}>
            <Label>Strategy</Label>
            <Radio label="Inflation %" value="inflation" checked={strategy === 'inflation'} onChange={setStrategy} />
            <Radio label="Floor £" value="floor" checked={strategy === 'floor'} onChange={setStrategy} />
            <Radio label="Greater of (inflation or floor)" value="greater" checked={strategy === 'greater'} onChange={setStrategy} />

            {(strategy === 'inflation' || strategy === 'greater') && (
              <div style={{ marginTop: 10 }}>
                <Label>Inflation %</Label>
                <input type="number" step="0.1" value={inflationPct} onChange={(e) => setInflationPct(e.target.value)} style={inputStyle} />
              </div>
            )}
            {(strategy === 'floor' || strategy === 'greater') && (
              <div style={{ marginTop: 10 }}>
                <Label>Floor £/month</Label>
                <input type="number" step="0.5" value={floorAmount} onChange={(e) => setFloorAmount(e.target.value)} style={inputStyle} />
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12, color: '#475569', cursor: 'pointer' }}>
              <input type="checkbox" checked={roundUp} onChange={(e) => setRoundUp(e.target.checked)} />
              Round up to nearest £0.50
            </label>

            <div style={{ marginTop: 14 }}>
              <Label>Effective from</Label>
              <input type="date" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ marginTop: 10 }}>
              <Label>Reason / note</Label>
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} placeholder="Annual fee review 2026" />
            </div>

            <div style={{ marginTop: 18, padding: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <Stat label="Lines" value={totals.lineCount} />
              <Stat label="Changed" value={totals.changed} />
              <Stat label="Current monthly" value={`£${totals.currMonthly.toFixed(2)}`} />
              <Stat label="New monthly" value={`£${totals.newMonthly.toFixed(2)}`} tone={totals.newMonthly > totals.currMonthly ? 'green' : 'slate'} />
              <Stat label="Δ monthly" value={`£${(totals.newMonthly - totals.currMonthly).toFixed(2)}`} tone="green" />
            </div>
          </div>

          {/* Preview table */}
          <div style={{ padding: 0, maxHeight: 520, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <Th>Client</Th>
                  <Th>Service</Th>
                  <Th align="right">Current</Th>
                  <Th align="right">New</Th>
                  <Th align="right">Δ</Th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <Td>{p.entityName}</Td>
                    <Td style={{ color: '#64748b' }}>{p.serviceLabel}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace' }}>£{p.current.toFixed(2)}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace', color: p.delta > 0 ? '#15803d' : p.delta < 0 ? '#b91c1c' : '#64748b' }}>£{p.proposed.toFixed(2)}</Td>
                    <Td align="right" style={{ fontFamily: 'monospace', color: p.delta > 0 ? '#15803d' : p.delta < 0 ? '#b91c1c' : '#94a3b8' }}>{p.delta > 0 ? '+' : ''}£{p.delta.toFixed(2)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={applying} style={btnGhost}>Cancel</button>
          <button onClick={apply} disabled={applying || totals.changed === 0} style={btnPrimary}>
            {applying ? 'Staging…' : `Stage uplift on ${totals.changed} line${totals.changed === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font };
const modalStyle = { background: '#fff', borderRadius: 12, width: 1000, maxWidth: '95vw', maxHeight: '90vh', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' };
const inputStyle = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', width: '100%', boxSizing: 'border-box' };
const btnPrimary = { padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };

const Label = ({ children }) => <div style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>{children}</div>;
const Th = ({ children, align }) => <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: align || 'left' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '6px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;

function Radio({ label, value, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 13, color: '#1e293b', cursor: 'pointer' }}>
      <input type="radio" checked={checked} onChange={() => onChange(value)} />
      {label}
    </label>
  );
}

function Stat({ label, value, tone }) {
  const fg = tone === 'green' ? '#15803d' : tone === 'slate' ? '#475569' : '#0f172a';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ fontWeight: 600, color: fg, fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}
