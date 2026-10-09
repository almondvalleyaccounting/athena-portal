// The bill line editor — ONE copy, shared by the Billing page (/billing) and
// the "+ Create" modal's Bill. Moved out of BillingPage.jsx unchanged so the
// two can't drift: Qty × Rate = Amount, VAT at 20% unless typed, sums typed
// into a box ("100*10"), the QuickBooks product's standard description, and
// "Copy from past invoice".

import React, { useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { fetchClientInvoices } from '../../lib/qboApi';
import { BTN } from '../../lib/buttonStyles';
import ServicePicker from './ServicePicker';

import {
  VAT_RATE, blankLine, splitOf, fmtNum, applyCalc, isExpression, evalArithmetic, buildLinesPayload, invoiceToLines,
} from './billLinesMath';

export { VAT_RATE, blankLine, splitOf, fmtNum, applyCalc, buildLinesPayload, invoiceToLines };

// The editor's state + handlers. serviceDefaults: service id → standard
// description (picking a service fills an empty / untouched description).
export function useBillLines(serviceDefaults) {
  const [formLines, setFormLines] = useState([blankLine()]);
  const changeLineField = (idx, key, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, [key]: value } : l));
  // Picking a service pulls through the standard description held on the
  // QuickBooks product. A description that's empty, or that was filled in this
  // way and not since touched (descAuto), is replaced when the service changes;
  // anything typed by hand stays exactly as typed.
  const changeLineService = (idx, value) => setFormLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const std = serviceDefaults[value] || '';
    const takeStd = !String(l.description || '').trim() || l.descAuto;
    return { ...l, service: value, description: takeStd ? std : l.description, descAuto: takeStd && !!std };
  }));
  const changeLineDescription = (idx, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, description: value, descAuto: false } : l));
  const changeLineCalc = (idx, field, value) => setFormLines((prev) => prev.map((l, i) => i === idx ? applyCalc(l, field, value) : l));
  const changeLineVat = (idx, value) => setFormLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const net = parseFloat(l.net) || 0; const vat = parseFloat(value) || 0;
    return { ...l, vat: value, vatManual: true, gross: (net + vat).toFixed(2) };
  }));
  const addLine = () => setFormLines((prev) => [...prev, blankLine()]);
  const removeLine = (idx) => setFormLines((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  const totals = formLines.reduce((t, l) => ({
    net: t.net + (parseFloat(l.net) || 0), vat: t.vat + (parseFloat(l.vat) || 0), gross: t.gross + (parseFloat(l.gross) || 0),
  }), { net: 0, vat: 0, gross: 0 });
  return {
    formLines, setFormLines, totals,
    changeLineField, changeLineService, changeLineDescription, changeLineCalc, changeLineVat, addLine, removeLine,
    canSubmit: formLines.some((l) => l.service && l.net !== ''),
  };
}

// A number box that also takes a sum ("100*10") and works it out on Tab/Enter.
export function CalcInput({ value, onChange, dp = 2, placeholder, style }) {
  const [draft, setDraft] = useState(null);
  const [bad, setBad] = useState(false);
  const text = draft !== null ? draft : (value ?? '');
  const handleChange = (e) => {
    const raw = e.target.value;
    setBad(false);
    if (isExpression(raw)) { setDraft(raw); return; }
    setDraft(null);
    onChange(raw);
  };
  const commit = () => {
    if (draft === null) return;
    const n = evalArithmetic(draft);
    // An unfinished sum stays put and goes red rather than silently
    // reverting — the typed figure isn't lost.
    if (n === null) { setBad(true); return; }
    setDraft(null); setBad(false);
    onChange(fmtNum(n, dp));
  };
  return (
    <input
      value={text}
      inputMode="decimal"
      placeholder={placeholder}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      style={bad ? { ...style, borderColor: '#dc2626', background: '#fef2f2' } : style}
      title={bad ? "That isn't a sum this can work out" : undefined}
    />
  );
}

export const LINE_COLS = '1.6fr 1.6fr 0.55fr 0.5fr 0.72fr 0.8fr 0.72fr 0.8fr 30px';
const font = "'Outfit', sans-serif";
const inputStyle = { width: '100%', padding: '8px 12px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: font, boxSizing: 'border-box' };
const numInput = { ...inputStyle, padding: '8px 7px', textAlign: 'right' };
const formLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4, fontFamily: font };
const calcHint = { background: '#f1f5f9', borderRadius: 4, padding: '1px 4px', fontFamily: 'monospace', color: '#475569' };
const btnOutline = { ...BTN.secondary.md, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' };

// The line grid: service, description, actual hrs, qty, rate, amount, VAT, gross.
export function BillLinesEditor({ form, services, serviceDefaults }) {
  const { formLines } = form;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: LINE_COLS, gap: 8, marginBottom: 4, paddingRight: 2 }}>
        <span style={formLabel}>Service *</span><span style={formLabel}>Description</span>
        <span style={formLabel} title="Athena only: never sent to QuickBooks or shown on the invoice">Actual hrs</span>
        <span style={formLabel}>Qty</span><span style={formLabel}>Rate (£)</span>
        <span style={formLabel}>Amount (£) *</span><span style={formLabel}>VAT (£)</span><span style={formLabel}>Gross (£)</span><span />
      </div>
      {formLines.map((l, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: LINE_COLS, gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
          {/* Searchable and grouped by QuickBooks category. A service the line
              already carries but that isn't in the list — copied from a QBO
              invoice, or unmapped since this bill was drafted — is kept and
              flagged, so editing an old bill can't silently blank its line. */}
          <ServicePicker value={l.service} options={services} onChange={(v) => form.changeLineService(idx, v)} style={inputStyle} />
          {/* Textarea so multi-line QBO descriptions keep their line breaks. */}
          <textarea
            value={l.description}
            onChange={(e) => form.changeLineDescription(idx, e.target.value)}
            placeholder={serviceDefaults[l.service] ? 'Standard description — type over it if this one differs' : 'Description for the invoice (visible to client)'}
            title={l.descAuto ? "The QuickBooks product's standard description — edit it freely" : undefined}
            rows={2}
            style={{ ...inputStyle, resize: 'vertical', minHeight: 38, lineHeight: 1.4, color: l.descAuto ? '#475569' : undefined }}
          />
          {/* Internal record of time actually spent. Not part of Qty × Rate, and
              the push builds QBO lines from named fields, so it never leaves Athena. */}
          <CalcInput value={l.hours} onChange={(v) => form.changeLineField(idx, 'hours', v)} dp={2} placeholder="—" style={{ ...numInput, background: '#fffbeb' }} />
          <CalcInput value={l.qty} onChange={(v) => form.changeLineCalc(idx, 'qty', v)} dp={4} placeholder="1" style={numInput} />
          <CalcInput value={l.rate} onChange={(v) => form.changeLineCalc(idx, 'rate', v)} dp={4} placeholder="0.00" style={numInput} />
          <CalcInput value={l.net} onChange={(v) => form.changeLineCalc(idx, 'net', v)} dp={2} placeholder="0.00" style={numInput} />
          <CalcInput value={l.vat} onChange={(v) => form.changeLineVat(idx, v)} dp={2} placeholder="0.00" style={numInput} />
          <input value={l.gross} placeholder="0.00" style={{ ...numInput, background: '#f8fafc' }} readOnly />
          <button onClick={() => form.removeLine(idx)} disabled={formLines.length === 1} title="Remove line"
            style={{ background: 'none', border: 'none', cursor: formLines.length === 1 ? 'default' : 'pointer', padding: 4, opacity: formLines.length === 1 ? 0.3 : 1, display: 'inline-flex' }}>
            <Trash2 size={15} style={{ color: '#94a3b8' }} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}>
        <button onClick={form.addLine} style={{ ...btnOutline, gap: 5, flexShrink: 0, whiteSpace: 'nowrap' }}><Plus size={14} /> Add line</button>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          Qty × Rate = Amount — fill in any two and the third works itself out. Sums work too: type <code style={calcHint}>100*10</code> then Tab.
          {' '}Not sure of the figure yet? Put <b>0</b> in Amount — it saves as a £0.00 placeholder and can&apos;t be approved until it&apos;s priced.
          {' '}<b>Actual hrs</b> is for us: it stays in Athena and never reaches QuickBooks or the invoice.
        </span>
      </div>
    </>
  );
}

// "Copy from past invoice": the client's last 24 months of QBO invoices; Copy
// hands that invoice's lines to onCopy (as editor lines).
export function PastInvoicePicker({ entityId, entityName, onCopy, onClose, fmt }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // "No matching QuickBooks customer" is an answer, not a fault — retrying it
  // gets the same answer. A QBO timeout is worth another go, so only that one
  // offers the button.
  const [retryable, setRetryable] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const load = React.useCallback(async () => {
    setLoading(true); setError(''); setRetryable(false); setInvoices([]); setExpanded(null);
    try {
      const res = await fetchClientInvoices(entityId);
      if (res?.customer_found === false) setError('This client has no matching QuickBooks customer yet.');
      setInvoices(res?.invoices || []);
    } catch (e) {
      setError(e.message || 'Could not load invoices from QuickBooks');
      setRetryable(true);
    }
    setLoading(false);
  }, [entityId]);
  React.useEffect(() => { load(); }, [load]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: '28px', maxWidth: 720, width: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.15)', fontFamily: font }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' }}>Copy from a past invoice</h2>
        <p style={{ fontSize: 14, color: '#64748b', marginBottom: 16 }}>{entityName || 'Client'} · last 24 months from QuickBooks</p>
        {loading && <p style={{ fontSize: 14, color: '#94a3b8', padding: '24px 0', textAlign: 'center' }}>Loading invoices from QuickBooks…</p>}
        {error && (
          <div style={{ fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>{error}</span>
            {retryable && (
              <button onClick={load} style={{ ...btnOutline, gap: 4, flexShrink: 0 }}><RefreshCw size={13} /> Try again</button>
            )}
          </div>
        )}
        {!loading && !error && invoices.length === 0 && <p style={{ fontSize: 14, color: '#94a3b8', padding: '24px 0', textAlign: 'center' }}>No invoices in the last 24 months.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {invoices.map((inv) => {
            const open = expanded === inv.id;
            return (
              <div key={inv.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                <div onClick={() => setExpanded(open ? null : inv.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: open ? '#f8fafc' : '#fff' }}>
                  <span style={{ fontSize: 13, color: '#94a3b8', width: 14 }}>{open ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', width: 96 }}>{inv.doc_number ? `INV #${inv.doc_number}` : '—'}</span>
                  <span style={{ fontSize: 13, color: '#64748b', flex: 1 }}>{inv.txn_date} · {inv.lines.length} line{inv.lines.length !== 1 ? 's' : ''}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{fmt(inv.total_amt)}</span>
                  <button onClick={(e) => { e.stopPropagation(); onCopy(invoiceToLines(inv)); }} style={{ ...BTN.primary.sm, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}><Plus size={13} /> Copy</button>
                </div>
                {open && (
                  <div style={{ borderTop: '1px solid #f1f5f9', padding: '8px 14px', background: '#fafafa' }}>
                    {inv.lines.map((l, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '4px 0', borderBottom: i < inv.lines.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                        <span style={{ fontWeight: 500, color: '#0f172a', minWidth: 150 }}>{l.service || '—'}</span>
                        <span style={{ color: '#64748b', flex: 1, whiteSpace: 'pre-line' }}>{l.description || ''}</span>
                        <span style={{ fontFamily: 'monospace', color: '#0f172a' }}>{fmt(l.amount)}</span>
                      </div>
                    ))}
                    {inv.lines.length === 0 && <p style={{ fontSize: 13, color: '#94a3b8', padding: '4px 0' }}>No service lines on this invoice.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnOutline}>Close</button>
        </div>
      </div>
    </div>
  );
}
