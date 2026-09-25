import React, { useState, useRef, useEffect } from 'react';
import { BTN } from '../../../lib/buttonStyles';

const labelStyle = {
  display: 'block', fontSize: 10, fontWeight: 600, color: '#94a3b8',
  marginBottom: 3,
  fontFamily: "'Outfit', sans-serif",
};
const btnBase = {
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};

export default function CompleteModal({ task, mode, onConfirm, onClose }) {
  const isNotReq = mode === 'not_required';
  const [mins, setMins] = useState('15');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const minsRef = useRef(null);
  const noteRef = useRef(null);

  useEffect(() => {
    if (isNotReq && noteRef.current) noteRef.current.focus();
    else if (minsRef.current) minsRef.current.focus();
  }, [isNotReq]);

  function handleConfirm() {
    if (saving) return;
    setSaving(true);
    const finalMins = isNotReq ? null : (Number(mins) || 15);
    onConfirm(task, finalMins, note.trim() || null);
  }

  const entityName = task._entityName || task.entity_name || '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)',
        zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
          padding: 18, width: 420, maxWidth: '92vw',
          maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          fontFamily: "'Outfit', sans-serif",
        }}
      >
        <h3 style={{
          fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 4,
        }}>
          {isNotReq ? 'Mark as Not Required' : 'Complete Task'}
        </h3>

        <p style={{ fontSize: 14, color: '#1e293b', marginBottom: 2 }}>{task.title}</p>
        {entityName && (
          <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>{entityName}</p>
        )}
        {!entityName && <div style={{ marginBottom: 14 }} />}

        {!isNotReq && (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Time Spent</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                ref={minsRef}
                type="number"
                min={1}
                max={999}
                value={mins}
                onChange={(e) => setMins(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
                style={{
                  width: 80, padding: '7px 10px', fontSize: 14.5, fontFamily: "'Outfit', sans-serif",
                  border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
                  color: '#0f172a', outline: 'none', textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 13, color: '#64748b' }}>minutes</span>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>
            {isNotReq ? 'Reason (optional)' : 'Completion Note (optional)'}
          </label>
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleConfirm(); }}
            placeholder={isNotReq ? 'Why is this not required...' : 'Add a final note...'}
            rows={3}
            style={{
              width: '100%', padding: '7px 10px', fontSize: 13, fontFamily: "'Outfit', sans-serif",
              border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
              color: '#0f172a', outline: 'none', resize: 'vertical', lineHeight: 1.5,
            }}
          />
          <p style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>Ctrl+Enter to confirm</p>
        </div>

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...BTN.secondary.sm, ...btnBase }}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            style={{
              ...BTN.primary.sm,
              // "Not required" keeps its slate fill: it marks the outcome, not a main action.
              ...(isNotReq ? { background: '#64748b', border: '1px solid #64748b' } : {}),
              ...btnBase,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : isNotReq ? 'Mark Not Required' : 'Complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
