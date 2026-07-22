import React, { useEffect, useState } from 'react';
import { getContract, upsertContract } from '../../api';
import { input, fieldLabel, btn, CONTRACT_STATUSES, fmtDate } from '../../recruitmentShared';

const STATUS_MAP = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s.key, s]));

export default function ContractPanel({ app, profileId }) {
  const [contract, setContract] = useState(undefined);
  const [f, setF] = useState({ contract_url: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    getContract(app.id).then((c) => {
      if (!live) return;
      setContract(c);
      if (c) setF({ contract_url: c.contract_url || '', notes: c.notes || '' });
    }).catch((e) => { setContract(null); setError(e.message); });
    return () => { live = false; };
  }, [app.id]);

  async function save(extra = {}) {
    setSaving(true); setError(null);
    try {
      const c = await upsertContract(app.id, {
        contract_url: f.contract_url.trim() || null,
        notes: f.notes.trim() || null,
        ...extra,
      }, profileId);
      setContract(c);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (contract === undefined) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>;
  const st = contract ? STATUS_MAP[contract.status] : null;
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div>
      {st && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: st.tone.bg, color: st.tone.fg, border: `1px solid ${st.tone.border}`, textTransform: 'uppercase' }}>{st.label}</span>
          {contract.sent_at && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Sent {fmtDate(contract.sent_at)}</span>}
          {contract.signed_at && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>· Signed {fmtDate(contract.signed_at)}</span>}
        </div>
      )}

      <label style={fieldLabel}>Contract document link</label>
      <input value={f.contract_url} onChange={set('contract_url')} style={input} placeholder="Drive / e-sign URL" />
      <div style={{ marginTop: 10 }}>
        <label style={fieldLabel}>Notes</label>
        <textarea value={f.notes} onChange={set('notes')} rows={2} style={{ ...input, resize: 'vertical' }} />
      </div>

      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={() => save()} disabled={saving} style={btn('primary')}>{contract ? 'Save' : 'Create contract record'}</button>
        {contract && contract.status === 'draft' && <button onClick={() => save({ status: 'sent', sent_at: new Date().toISOString() })} style={btn('secondary')}>Mark sent</button>}
        {contract && contract.status === 'sent' && <>
          <button onClick={() => save({ status: 'signed', signed_at: new Date().toISOString() })} style={{ ...btn('secondary'), color: '#166534', borderColor: '#bbf7d0' }}>Mark signed</button>
          <button onClick={() => save({ status: 'declined' })} style={{ ...btn('secondary'), color: '#b91c1c', borderColor: '#fecaca' }}>Declined</button>
        </>}
      </div>
      <p style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 12 }}>
        E-signature isn't wired in yet — record the document link and track its status here. Full e-sign can reuse the client-portal document flow in a later pass.
      </p>
    </div>
  );
}
