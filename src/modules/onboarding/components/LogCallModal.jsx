import React, { useState } from 'react';
import { tones, pillStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import ModalShell from './ModalShell';
import { CALL_OUTCOMES, logOnboardingCall } from '../api';

const font = "'Outfit', sans-serif";

// Record a phone call against the onboarding. It lands on the comms timeline
// next to the emails, and "Spoke to the client" clears a Call needed flag.
export default function LogCallModal({ onboarding, onClose, onLogged }) {
  const [outcome, setOutcome] = useState('spoke');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      await logOnboardingCall(onboarding.id, outcome, note.trim());
      onLogged?.();
      onClose();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <ModalShell
      title="Log call"
      subtitle={onboarding.entity?.name}
      width={520}
      onClose={onClose}
      footer={(
        <>
          {error && <span style={{ fontSize: 13, color: tones.danger.fg, flex: 1 }}>{error}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={BTN.secondary.md}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ ...BTN.primary.md, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Log call'}
            </button>
          </div>
        </>
      )}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>Outcome</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {CALL_OUTCOMES.map((o) => (
          <button key={o.value} onClick={() => setOutcome(o.value)} style={pillStyle({ tone: 'info', active: outcome === o.value })}>
            {o.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>What was said</div>
      <textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Sending the UTR letter tonight; ID to follow by Friday"
        style={{
          width: '100%', minHeight: 120, resize: 'vertical', boxSizing: 'border-box', padding: '9px 11px',
          fontSize: 14, lineHeight: 1.5, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8,
        }}
      />
    </ModalShell>
  );
}
