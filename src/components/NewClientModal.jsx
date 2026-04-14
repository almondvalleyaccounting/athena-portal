import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/*
  Shared "Add new client" modal used across the portal.
  Collects: name (required), email, entity type.

  Props:
    open        — boolean, controls visibility
    onClose     — called when modal should close (cancel / backdrop click)
    onSave      — async (fields) => entity | null — the parent handles the
                  Supabase insert and returns the new entity row.
                  If it returns a truthy value the modal closes automatically.
    initialName — optional pre-fill for name (e.g. from typeahead query)
*/

const ENTITY_TYPES = [
  { value: 'limited_company', label: 'Limited Company' },
  { value: 'sole_trader', label: 'Sole Trader' },
  { value: 'partnership', label: 'Partnership' },
];

export default function NewClientModal({ open, onClose, onSave, initialName = '' }) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState('');
  const [entityType, setEntityType] = useState('limited_company');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef(null);

  // Reset fields when modal opens
  useEffect(() => {
    if (open) {
      setName(initialName);
      setEmail('');
      setEntityType('limited_company');
      setError('');
      setSaving(false);
      // Focus name input after render
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open, initialName]);

  if (!open) return null;

  const canSave = name.trim().length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError('');

    try {
      const result = await onSave({
        name: name.trim(),
        prospect_email: email.trim() || null,
        type: entityType,
        status: 'prospect',
      });
      if (result) {
        onClose();
      }
    } catch (err) {
      setError(err?.message || 'Failed to create client. Please try again.');
    }
    setSaving(false);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '420px',
          padding: '32px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
          position: 'relative',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#94a3b8', padding: '4px',
          }}
        >
          <X size={18} />
        </button>

        {/* Title */}
        <h2
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '22px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '4px',
          }}
        >
          New Client
        </h2>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            color: '#64748b',
            marginBottom: '24px',
          }}
        >
          Add a new client to Athena. BrightManager clients are synced separately.
        </p>

        {/* Name */}
        <label style={labelStyle}>Name *</label>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder="Client or business name"
          disabled={saving}
          style={inputStyle}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        {/* Email */}
        <label style={{ ...labelStyle, marginTop: '16px' }}>Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder="contact@example.com"
          type="email"
          disabled={saving}
          style={inputStyle}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />

        {/* Entity type */}
        <label style={{ ...labelStyle, marginTop: '16px' }}>Type</label>
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          disabled={saving}
          style={{
            ...inputStyle,
            cursor: 'pointer',
            appearance: 'auto',
          }}
        >
          {ENTITY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {/* Error */}
        {error && (
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '12px',
              color: '#ef4444',
              marginTop: '12px',
            }}
          >
            {error}
          </p>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              flex: 1,
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: 600,
              color: '#64748b',
              backgroundColor: '#ffffff',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              flex: 1,
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: 600,
              color: canSave ? '#ffffff' : '#94a3b8',
              backgroundColor: canSave ? '#0f172a' : '#e5e7eb',
              border: 'none',
              borderRadius: '10px',
              padding: '12px',
              cursor: canSave ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s ease',
            }}
          >
            {saving ? 'Saving...' : 'Add Client'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block',
  fontFamily: "'Outfit', sans-serif",
  fontSize: '12px',
  fontWeight: 600,
  color: '#64748b',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const inputStyle = {
  width: '100%',
  fontFamily: "'Outfit', sans-serif",
  fontSize: '14px',
  color: '#0f172a',
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '12px 16px',
  outline: 'none',
  transition: 'border-color 0.2s ease',
  boxSizing: 'border-box',
};
