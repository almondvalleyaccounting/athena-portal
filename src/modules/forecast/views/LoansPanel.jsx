import React, { useEffect, useState } from 'react';
import { listLoans, upsertLoan, deleteLoan } from '../lib/queries';
import { btnDark, btnGhost, btnOutline, colors, fontStack, inputStyle, Pill, Section, serifStack } from '../components/ui';

export default function LoansPanel({ scenarioId, onChanged }) {
  const [loans, setLoans] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    if (!scenarioId) return;
    try { setLoans(await listLoans(scenarioId)); } catch (e) { alert(e.message); }
  };

  useEffect(() => { reload(); }, [scenarioId]);

  const onSave = async (form) => {
    setBusy(true);
    try {
      await upsertLoan({
        ...form,
        scenario_id: scenarioId,
        principal_p: Math.round(Number(form.principal_pounds) * 100),
        interest_pct: Number(form.interest_pct),
        start_month: Number(form.start_month),
        term_months: Number(form.term_months),
        principal_pounds: undefined,
      });
      setEditing(null);
      await reload();
      onChanged?.();
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  const onDelete = async (id) => {
    if (!confirm('Delete this loan?')) return;
    try { await deleteLoan(id); await reload(); onChanged?.(); }
    catch (e) { alert(e.message); }
  };

  return (
    <Section
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Loans
          {loans.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: colors.muted, fontFamily: fontStack }}>
              · {loans.length} loan{loans.length !== 1 ? 's' : ''}
            </span>
          )}
        </span>
      }
      right={<button onClick={() => setEditing({})} style={btnDark}>+ Add loan</button>}
    >
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 10px' }}>
        Bank facilities and director loans. Property mortgages live with the property in <strong>Locations</strong> (lease/buy mode).
        Principal is drawn at the start month; thereafter amortising loans pay fixed interest+principal monthly, interest-only loans pay only interest with a balloon at term end.
      </p>
      {loans.length === 0 ? (
        <p style={{ fontSize: 12, color: colors.muted, fontStyle: 'italic' }}>
          No loans yet. Add a director loan or bank facility to model debt-funded growth.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: colors.bgSoft }}>
              <th style={th}>Label</th>
              <th style={th}>Kind</th>
              <th style={{ ...th, textAlign: 'right' }}>Principal</th>
              <th style={{ ...th, textAlign: 'right' }}>Start (m)</th>
              <th style={{ ...th, textAlign: 'right' }}>Term (m)</th>
              <th style={{ ...th, textAlign: 'right' }}>Rate</th>
              <th style={th}>Payment</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loans.map(l => (
              <tr key={l.id} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                <td style={td}><strong>{l.label}</strong>{l.notes && <div style={{ fontSize: 10, color: colors.muted }}>{l.notes}</div>}</td>
                <td style={td}><Pill color={l.kind === 'director' ? '#7c3aed' : colors.accent}>{l.kind}</Pill></td>
                <td style={tdR}>£{(Number(l.principal_p) / 100).toLocaleString('en-GB')}</td>
                <td style={tdR}>{l.start_month}</td>
                <td style={tdR}>{l.term_months}</td>
                <td style={tdR}>{Number(l.interest_pct).toFixed(2)}%</td>
                <td style={td}>{l.payment_kind}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => setEditing(l)} style={btnGhost}>Edit</button>
                  <button onClick={() => onDelete(l.id)} style={{ ...btnGhost, marginLeft: 6, color: colors.red }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <LoanModal
          loan={editing}
          onClose={() => setEditing(null)}
          onSave={onSave}
          busy={busy}
        />
      )}
    </Section>
  );
}

function LoanModal({ loan, onClose, onSave, busy }) {
  const [form, setForm] = useState({
    id: loan.id || undefined,
    kind: loan.kind || 'bank',
    label: loan.label || '',
    principal_pounds: loan.principal_p != null ? (Number(loan.principal_p) / 100).toString() : '',
    start_month: loan.start_month ?? 0,
    term_months: loan.term_months ?? 60,
    interest_pct: loan.interest_pct != null ? Number(loan.interest_pct).toString() : '6.5',
    payment_kind: loan.payment_kind || 'amortising',
    notes: loan.notes || '',
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = () => {
    if (!form.label.trim()) { alert('Label required'); return; }
    if (!form.principal_pounds || Number(form.principal_pounds) <= 0) { alert('Principal must be positive'); return; }
    onSave(form);
  };
  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '0 0 16px' }}>
          {form.id ? 'Edit loan' : 'New loan'}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Label">
            <input value={form.label} onChange={set('label')} placeholder="e.g. RBS term loan" style={inputStyle} />
          </Field>
          <Field label="Kind">
            <select value={form.kind} onChange={set('kind')} style={{ ...inputStyle, padding: '6px' }}>
              <option value="bank">Bank loan</option>
              <option value="director">Director loan</option>
            </select>
          </Field>
          <Field label="Principal (£)">
            <input value={form.principal_pounds} onChange={set('principal_pounds')} inputMode="decimal" style={inputStyle} placeholder="e.g. 250000" />
          </Field>
          <Field label="Annual interest %">
            <input value={form.interest_pct} onChange={set('interest_pct')} inputMode="decimal" style={inputStyle} />
          </Field>
          <Field label="Start month (offset)">
            <input type="number" value={form.start_month} onChange={set('start_month')} style={inputStyle} />
          </Field>
          <Field label="Term (months)">
            <input type="number" value={form.term_months} onChange={set('term_months')} style={inputStyle} />
          </Field>
          <Field label="Payment kind">
            <select value={form.payment_kind} onChange={set('payment_kind')} style={{ ...inputStyle, padding: '6px' }}>
              <option value="amortising">Amortising (fixed monthly)</option>
              <option value="interest_only">Interest-only + balloon</option>
            </select>
          </Field>
          <Field label="Notes (optional)">
            <input value={form.notes} onChange={set('notes')} style={inputStyle} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: colors.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack };
const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}` };
const td = { padding: '8px 10px', color: colors.ink };
const tdR = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' };
const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const modalCard = { background: '#fff', borderRadius: 16, padding: 28, maxWidth: 640, width: '100%' };
