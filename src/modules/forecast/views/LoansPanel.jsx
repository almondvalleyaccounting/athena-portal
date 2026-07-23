import React, { useEffect, useState } from 'react';
import { listLoans, upsertLoan, deleteLoan } from '../lib/queries';
import { btnGhost, colors, fontStack, inputStyle, Pill, Section } from '../components/ui';

// Fixed loan structure: five always-visible slots (Loan 1–5), edited
// inline — amount, interest, start month, term, plus type and repayment.
// Type an amount into an empty slot to create the loan; clear it with ×.
const MAX_SLOTS = 5;

const NEW_DEFAULTS = { kind: 'bank', interest_pct: '6.5', start_month: '0', term_months: '60', payment_kind: 'amortising' };

export default function LoansPanel({ scenarioId, onChanged }) {
  const [loans, setLoans] = useState([]);
  const [drafts, setDrafts] = useState({});   // slot index -> partial draft for empty slots

  const reload = async () => {
    if (!scenarioId) return;
    try { setLoans(await listLoans(scenarioId)); } catch (e) { alert(e.message); }
  };

  useEffect(() => { setDrafts({}); reload(); }, [scenarioId]);

  const saveField = async (loan, field, raw) => {
    const parsed = parseField(field, raw);
    if (parsed == null || parsed === loan[field]) return;
    try {
      await upsertLoan({ ...loan, [field]: parsed });
      await reload();
      onChanged?.();
    } catch (e) { alert(e.message); }
  };

  const setDraft = (slot, field, raw) => {
    setDrafts(prev => ({ ...prev, [slot]: { ...(prev[slot] || {}), [field]: raw } }));
  };

  // Creating a new loan needs an amount; every other field falls back to
  // a sensible default so one number is enough to get going.
  const tryCreate = async (slot, overlay = {}) => {
    // `overlay` carries the value from the blur/change that triggered the
    // call — React state (`drafts`) won't have flushed it yet.
    const d = { ...NEW_DEFAULTS, ...(drafts[slot] || {}), ...overlay };
    const principal = Number(d.principal_pounds);
    if (!d.principal_pounds || Number.isNaN(principal) || principal <= 0) return;
    try {
      await upsertLoan({
        scenario_id: scenarioId,
        kind: d.kind,
        label: (d.label || '').trim() || `Loan ${slot + 1}`,
        principal_p: Math.round(principal * 100),
        interest_pct: Number(d.interest_pct) || 0,
        start_month: Math.round(Number(d.start_month) || 0),
        term_months: Math.max(1, Math.round(Number(d.term_months) || 60)),
        payment_kind: d.payment_kind,
        notes: '',
      });
      setDrafts(prev => { const c = { ...prev }; delete c[slot]; return c; });
      await reload();
      onChanged?.();
    } catch (e) { alert(e.message); }
  };

  const onDelete = async (loan) => {
    if (!confirm(`Delete "${loan.label}"?`)) return;
    try { await deleteLoan(loan.id); await reload(); onChanged?.(); }
    catch (e) { alert(e.message); }
  };

  const slotCount = Math.max(MAX_SLOTS, loans.length);

  return (
    <Section
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Lending
          {loans.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 400, color: colors.muted, fontFamily: fontStack }}>
              · {loans.length} of {MAX_SLOTS} loans
            </span>
          )}
        </span>
      }
    >
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 10px' }}>
        Bank facilities and director loans — type an amount on an empty row to add one.
        Principal is drawn at the start month; amortising loans repay fixed interest+principal monthly,
        interest-only loans pay interest with a balloon at term end. Property mortgages live with the
        property in <strong>Locations</strong> (lease/buy mode).
      </p>
      <table style={tableStyle}>
        <thead>
          <tr style={{ background: colors.bgSoft }}>
            <th style={th}></th>
            <th style={th}>Label</th>
            <th style={th}>Type</th>
            <th style={{ ...th, textAlign: 'right' }}>Loan amount (£)</th>
            <th style={{ ...th, textAlign: 'right' }}>Interest % pa</th>
            <th style={{ ...th, textAlign: 'right' }}>Start month</th>
            <th style={{ ...th, textAlign: 'right' }}>Term (months)</th>
            <th style={th}>Repayment</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: slotCount }, (_, slot) => {
            const loan = loans[slot];
            return loan
              ? <LoanRow key={loan.id} slot={slot} loan={loan} onField={saveField} onDelete={onDelete} />
              : <EmptyRow key={`empty-${slot}`} slot={slot} draft={drafts[slot] || {}} setDraft={setDraft} tryCreate={tryCreate} />;
          })}
        </tbody>
      </table>
    </Section>
  );
}

function LoanRow({ slot, loan, onField, onDelete }) {
  return (
    <tr style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
      <td style={{ ...td, color: colors.muted, whiteSpace: 'nowrap' }}>Loan {slot + 1}</td>
      <td style={td}>
        <input defaultValue={loan.label} onBlur={(e) => onField(loan, 'label', e.target.value)} style={{ ...cellInput, width: 150, textAlign: 'left' }} />
      </td>
      <td style={td}>
        <select value={loan.kind} onChange={(e) => onField(loan, 'kind', e.target.value)} style={cellSelect}>
          <option value="bank">Bank</option>
          <option value="director">Director</option>
        </select>
      </td>
      <td style={tdR}>
        <input defaultValue={Number(loan.principal_p) / 100} inputMode="decimal" onBlur={(e) => onField(loan, 'principal_p', e.target.value)} style={cellInput} />
      </td>
      <td style={tdR}>
        <input defaultValue={Number(loan.interest_pct)} inputMode="decimal" onBlur={(e) => onField(loan, 'interest_pct', e.target.value)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={tdR}>
        <input defaultValue={loan.start_month} inputMode="numeric" onBlur={(e) => onField(loan, 'start_month', e.target.value)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={tdR}>
        <input defaultValue={loan.term_months} inputMode="numeric" onBlur={(e) => onField(loan, 'term_months', e.target.value)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={td}>
        <select value={loan.payment_kind} onChange={(e) => onField(loan, 'payment_kind', e.target.value)} style={cellSelect}>
          <option value="amortising">Amortising</option>
          <option value="interest_only">Interest-only + balloon</option>
        </select>
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <button onClick={() => onDelete(loan)} title="Delete loan" style={{ ...btnGhost, color: colors.red }}>×</button>
      </td>
    </tr>
  );
}

function EmptyRow({ slot, draft, setDraft, tryCreate }) {
  const d = { ...NEW_DEFAULTS, label: `Loan ${slot + 1}`, ...draft };
  const blur = (field) => (e) => { setDraft(slot, field, e.target.value); tryCreate(slot, { [field]: e.target.value }); };
  const change = (field) => (e) => { setDraft(slot, field, e.target.value); tryCreate(slot, { [field]: e.target.value }); };
  return (
    <tr style={{ borderBottom: `1px solid ${colors.borderSoft}`, opacity: 0.75 }}>
      <td style={{ ...td, color: colors.muted, whiteSpace: 'nowrap' }}>Loan {slot + 1}</td>
      <td style={td}>
        <input value={draft.label ?? ''} placeholder={`Loan ${slot + 1}`} onChange={(e) => setDraft(slot, 'label', e.target.value)} onBlur={() => tryCreate(slot)} style={{ ...cellInput, width: 150, textAlign: 'left' }} />
      </td>
      <td style={td}>
        <select value={d.kind} onChange={change('kind')} style={cellSelect}>
          <option value="bank">Bank</option>
          <option value="director">Director</option>
        </select>
      </td>
      <td style={tdR}>
        <input value={draft.principal_pounds ?? ''} placeholder="amount to add" inputMode="decimal" onChange={(e) => setDraft(slot, 'principal_pounds', e.target.value)} onBlur={blur('principal_pounds')} style={cellInput} />
      </td>
      <td style={tdR}>
        <input value={draft.interest_pct ?? ''} placeholder={NEW_DEFAULTS.interest_pct} inputMode="decimal" onChange={(e) => setDraft(slot, 'interest_pct', e.target.value)} onBlur={() => tryCreate(slot)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={tdR}>
        <input value={draft.start_month ?? ''} placeholder={NEW_DEFAULTS.start_month} inputMode="numeric" onChange={(e) => setDraft(slot, 'start_month', e.target.value)} onBlur={() => tryCreate(slot)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={tdR}>
        <input value={draft.term_months ?? ''} placeholder={NEW_DEFAULTS.term_months} inputMode="numeric" onChange={(e) => setDraft(slot, 'term_months', e.target.value)} onBlur={() => tryCreate(slot)} style={{ ...cellInput, width: 70 }} />
      </td>
      <td style={td}>
        <select value={d.payment_kind} onChange={change('payment_kind')} style={cellSelect}>
          <option value="amortising">Amortising</option>
          <option value="interest_only">Interest-only + balloon</option>
        </select>
      </td>
      <td style={td}></td>
    </tr>
  );
}

// Loan field parsing for inline edits: money → pence, numerics rounded,
// text trimmed; null = invalid, don't save.
function parseField(field, raw) {
  const s = String(raw).trim();
  if (field === 'label') return s || null;
  if (field === 'kind' || field === 'payment_kind') return s;
  if (s === '') return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  if (field === 'principal_p') return n > 0 ? Math.round(n * 100) : null;
  if (field === 'interest_pct') return n;
  if (field === 'start_month') return Math.max(0, Math.round(n));
  if (field === 'term_months') return Math.max(1, Math.round(n));
  return null;
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack };
const th = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' };
const td = { padding: '5px 8px', color: colors.ink, verticalAlign: 'middle' };
const tdR = { ...td, textAlign: 'right' };
const cellInput = { ...inputStyle, width: 110, textAlign: 'right', padding: '4px 7px', fontSize: 12 };
const cellSelect = { ...inputStyle, padding: '4px 6px', fontSize: 12, width: 'auto' };
