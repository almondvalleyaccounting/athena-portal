import React, { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';
import { fmtDateLong, fmtMoney, taxPaymentRef, utr10 } from './lib';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const ACCENT = '#0e7fe0';

/*
  ManualPaymentModal — add a tax payment for a client by hand.

  Some clients join us after their Self Assessment was filed elsewhere, so
  they never appear in the TaxCalc payments-on-account export: the client
  exists in Athena, only the payment figures are missing. This keys one in
  against the selected batch, so from then on it behaves exactly like an
  imported row — opt-in invitation, reminder, paid/excluded, the lot.

  The row is stamped source='manual' so it stays editable and deletable
  (imported rows are neither — they would drift from TaxCalc).

  Props:
    batch     — { id, label, due_date } the row is added to
    entities  — [{ id, name, utr, entity_status, ... }] full list
    rows      — existing tax_payments_due rows for this batch (duplicate check)
    emailOf   — (row-like {entity_id}) => email string|null, from the page
    profileId — staff id recorded as added_by
    onClose   — () => void
    onSaved   — (clientName) => void
*/

const btnPrimary = (enabled) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: enabled ? ACCENT : '#e5e7eb', color: enabled ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: enabled ? 'pointer' : 'default',
});
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb',
  borderRadius: 8, cursor: 'pointer',
};
const lbl = { fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, display: 'block' };
const input = {
  padding: '6px 10px', fontSize: 12.5, fontFamily: font, border: '1px solid #e5e7eb',
  borderRadius: 8, background: '#fff', color: '#0f172a',
};

function Note({ tone, children }) {
  const tones = {
    warn: { bg: '#fffbeb', border: '#fde68a', color: '#92400e' },
    error: { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' },
    info: { bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
  };
  const t = tones[tone] || tones.info;
  return (
    <div style={{
      padding: '8px 11px', background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: 8, fontSize: 12, color: t.color, marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

export default function ManualPaymentModal({ batch, entities, rows, emailOf, profileId, onClose, onSaved }) {
  const [entityId, setEntityId] = useState('');
  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [utrTouched, setUtrTouched] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Former clients are never reminded, so don't offer them here either.
  const pickable = useMemo(
    () => (entities || []).filter((e) => !['nlac', 'archived'].includes(e.entity_status)),
    [entities],
  );
  const ent = entityId ? (entities || []).find((e) => e.id === entityId) : null;

  // Selecting a client pre-fills the UTR we already hold; staff can correct
  // it (or clear it) and their edit then sticks across further changes.
  const chooseEntity = (id) => {
    setEntityId(id || '');
    if (!utrTouched) {
      const e = (entities || []).find((x) => x.id === id);
      setUtr(e && e.utr ? String(e.utr) : '');
    }
  };

  const amountNum = amount.trim() === '' ? null : Number(amount.replace(/[£,\s]/g, ''));
  const amountValid = amountNum != null && Number.isFinite(amountNum) && amountNum > 0;
  const utrClean = utr10(utr);
  const utrPartial = utr.replace(/\D/g, '').length > 0 && !utrClean;

  const duplicate = useMemo(
    () => (rows || []).find((r) => r.entity_id && r.entity_id === entityId) || null,
    [rows, entityId],
  );
  const email = ent ? emailOf({ entity_id: ent.id }) : null;

  const canSave = !!batch && !!ent && amountValid && !utrPartial && !duplicate && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const { error } = await supabase.from('tax_payments_due').insert({
        batch_id: batch.id,
        entity_id: ent.id,
        client_name_raw: ent.name,
        reference_raw: utrClean || null,
        amount: amountNum,
        status: 'unpaid',
        status_note: note.trim() || null,
        source: 'manual',
        added_by: profileId || null,
      });
      if (error) throw error;
      onSaved(ent.name);
    } catch (ex) {
      setErr(`Could not add that payment: ${ex.message || String(ex)}`);
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ ...card, width: 560, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Add a client payment by hand</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 14px' }}>
          For clients whose figures aren't in the TaxCalc export — typically someone who joined
          us after their return was filed elsewhere. Take the amount from their HMRC statement
          or the return they've given us.
          {batch && <> It joins <strong>{batch.label}</strong>, due {fmtDateLong(batch.due_date)}.</>}
        </p>

        {err && <Note tone="error">{err}</Note>}

        <div style={{ marginBottom: 12 }}>
          <span style={lbl}>Client *</span>
          <ClientTypeAhead
            entityList={pickable}
            value={entityId}
            onChange={chooseEntity}
            metaOf={(e) => [
              e.utr && `UTR ${e.utr}`,
              e.bm_client_id && `ref ${e.bm_client_id}`,
            ].filter(Boolean).join(' · ')}
          />
        </div>

        {duplicate && (
          <Note tone="warn">
            <strong>{ent ? ent.name : 'That client'}</strong> is already in this batch
            (£{fmtMoney(duplicate.amount)}
            {duplicate.source === 'manual' ? ', added by hand' : ', from the import'}).
            Edit that row instead of adding a second one.
          </Note>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <span style={lbl}>Amount due (£) *</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="2450.00"
              style={{ ...input, width: 130 }}
            />
          </div>
          <div>
            <span style={lbl}>UTR (10 digits)</span>
            <input
              value={utr}
              onChange={(e) => { setUtrTouched(true); setUtr(e.target.value); }}
              placeholder="1234567890"
              style={{ ...input, width: 150 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <span style={lbl}>Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. figure from HMRC statement 04/08"
              style={{ ...input, width: '100%' }}
            />
          </div>
        </div>

        {amount.trim() !== '' && !amountValid && (
          <Note tone="error">Enter the amount due as a number greater than zero.</Note>
        )}
        {utrPartial && (
          <Note tone="error">
            A UTR is 10 digits — that's {utr.replace(/\D/g, '').length}. Correct it, or clear the
            box to send without a payment reference.
          </Note>
        )}

        {ent && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', marginBottom: 14, background: '#f8fafc' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
              What the reminder will use
            </div>
            <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.7 }}>
              <div>
                Email:{' '}
                {email
                  ? <strong>{email}</strong>
                  : <span style={{ color: '#b91c1c', fontWeight: 600 }}>none on file — add one to the client before sending</span>}
              </div>
              <div>
                Payment reference:{' '}
                {utrClean
                  ? <strong>{taxPaymentRef(utrClean)}</strong>
                  : <span style={{ color: '#92400e' }}>none — they'll get the "no UTR yet" wording instead of a payment reference</span>}
              </div>
              <div>Amount: {amountValid ? <strong>£{fmtMoney(amountNum)}</strong> : '—'}</div>
            </div>
          </div>
        )}

        <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 12 }}>
          Adding the payment doesn't email anyone. The row lands as <strong>Unpaid</strong> in the
          batch — they still need to opt in, and every send goes through the review queue.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={!canSave} style={btnPrimary(canSave)}>
            {saving ? 'Adding…' : 'Add payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
