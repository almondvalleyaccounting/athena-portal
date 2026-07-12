import React, { useState } from 'react';
import { ArrowRightLeft, CheckCircle2 } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { updateOnboarding } from '../api';

const font = "'Outfit', sans-serif";
const input = {
  padding: '6px 9px', fontSize: 12.5, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 7,
};

/*
  Timed handover: the onboarding buddy (owner) brings the client on; after a
  settling-in period the client is handed to their permanent team member.
  Due date passing shows a chip on the pipeline and here until marked done.
*/
export default function HandoverPanel({ ob, staff, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const due = ob.handover_due && !ob.handover_done_at && new Date(ob.handover_due) <= new Date();
  const toName = staff.find((s) => s.id === ob.handover_to)?.name;

  async function save(patch, logBody) {
    setBusy(true); setMsg(null);
    try { await updateOnboarding(ob.id, patch, { actorId: profile?.id, logBody }); onChanged?.(); }
    catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${due ? tones.warning.border : '#e5e7eb'}`, borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <ArrowRightLeft size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Handover
        </span>
        {ob.handover_done_at && <span style={chipStyle('success')}>done</span>}
        {due && <span style={chipStyle('warning')}>DUE</span>}
      </div>

      {ob.handover_done_at ? (
        <div style={{ fontSize: 12.5, color: '#475569' }}>
          Handed over to <strong>{toName || '—'}</strong> on {new Date(ob.handover_done_at).toLocaleDateString('en-GB')}.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
            {ob.owner?.name || 'The buddy'} settles the client in, then hands them to their permanent team member.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              style={input} value={ob.handover_to || ''} disabled={busy}
              onChange={(e) => save({ handover_to: e.target.value || null })}
            >
              <option value="">Hand over to…</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input
              type="date" style={input} value={ob.handover_due || ''} disabled={busy}
              onChange={(e) => save({ handover_due: e.target.value || null })}
            />
            {ob.handover_to && (
              <button
                disabled={busy}
                onClick={() => save(
                  { handover_done_at: new Date().toISOString(), owner_id: ob.handover_to },
                  `Handover complete — ${toName} takes over from ${ob.owner?.name || 'the onboarding buddy'} as owner.`,
                )}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 600, fontFamily: font, background: tones.success.solid, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
              >
                <CheckCircle2 size={13} /> Mark handed over
              </button>
            )}
          </div>
          {due && (
            <div style={{ fontSize: 12, color: tones.warning.fg, marginTop: 8 }}>
              Due {new Date(ob.handover_due).toLocaleDateString('en-GB')} — time to move this client to {toName || 'their permanent team member'}.
            </div>
          )}
        </>
      )}
      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
