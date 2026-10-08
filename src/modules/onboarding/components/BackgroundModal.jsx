import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { tones } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';

const font = "'Outfit', sans-serif";

/*
  The onboarding's background notes (onboardings.notes — internal notes and
  whatever was imported with the client). Long-form, so it gets a proper
  editing space rather than a box squeezed into the side column.
*/
export default function BackgroundModal({ clientName, value, onClose, onSave }) {
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const dirty = text !== value;

  function close() {
    if (dirty && !window.confirm('Discard your changes to the background notes?')) return;
    onClose();
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function save() {
    setSaving(true); setError(null);
    try { await onSave(text.trim() ? text : ''); }
    catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: font,
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="Background"
        style={{
          background: '#fff', borderRadius: 12, width: 'min(720px, 100%)', maxHeight: 'calc(100vh - 32px)',
          display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Background</div>
            {clientName && <div style={{ fontSize: 13, color: '#64748b' }}>{clientName}</div>}
          </div>
          <button
            onClick={close} title="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: '14px 18px', flex: 1, minHeight: 0, display: 'flex' }}>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Internal notes / imported background…"
            style={{
              flex: 1, width: '100%', minHeight: 320, resize: 'vertical', boxSizing: 'border-box',
              padding: '10px 12px', fontSize: 14, lineHeight: 1.5, fontFamily: font,
              border: '1px solid #cbd5e1', borderRadius: 8, whiteSpace: 'pre-wrap',
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid #f1f5f9' }}>
          {error && <span style={{ fontSize: 13, color: tones.danger.fg, flex: 1 }}>{error}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={close} style={BTN.secondary.md}>Cancel</button>
            <button onClick={save} disabled={!dirty || saving} style={{ ...BTN.primary.md, opacity: !dirty || saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
