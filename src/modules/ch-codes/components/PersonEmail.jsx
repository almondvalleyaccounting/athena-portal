import React, { useState } from 'react';
import { Mail, Pencil } from 'lucide-react';
import { chipStyle, tones } from '../../../lib/tokens';
import { setPersonEmail } from '../api';

const font = "'Outfit', sans-serif";
export const isEmail = (e) => typeof e === 'string' && e.includes('@');

/*
  Add or correct the chased person's email without leaving the CH-codes
  screens. Nothing can be chased without one — Sophie was being sent off to
  the people record to fill the gap, which meant losing her place in the
  pipeline.

  mode="chip"   — pipeline tiles: an amber "add email" chip when it's missing,
                  nothing at all when we already hold one.
  mode="banner" — detail page: the missing-email warning, or the address on
                  file with an edit affordance.
*/
export default function PersonEmail({ person, requestId, actorId, onSaved, mode = 'chip' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person?.email || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const have = isEmail(person?.email);
  // No person record to hang an address on — nothing to offer.
  if (!person?.id) return null;

  async function save() {
    const value = draft.trim();
    if (!isEmail(value)) { setErr('That doesn’t look like an email address.'); return; }
    setBusy(true); setErr(null);
    try {
      await setPersonEmail(person.id, value, { requestId, actorId });
      setEditing(false);
      onSaved?.(value);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  function open(e) {
    e.stopPropagation();
    setDraft(person?.email || '');
    setErr(null);
    setEditing(true);
  }

  if (editing) {
    return (
      <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <input
          autoFocus type="email" value={draft} placeholder="name@company.co.uk" disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { setEditing(false); setErr(null); }
          }}
          style={{
            width: mode === 'banner' ? 280 : 210, padding: '4px 8px', fontSize: 12.5, fontFamily: font,
            border: '1px solid #93c5fd', borderRadius: 7,
          }}
        />
        <button
          onClick={save} disabled={busy || !draft.trim()}
          style={{
            fontFamily: font, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 7, cursor: 'pointer',
            background: tones.success.solid, color: '#fff', border: 'none', opacity: busy || !draft.trim() ? 0.5 : 1,
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => { setEditing(false); setErr(null); }}
          style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer', fontFamily: font }}
        >
          Cancel
        </button>
        {err && <span style={{ fontSize: 12, color: tones.danger.fg }}>{err}</span>}
      </span>
    );
  }

  if (mode === 'banner') {
    if (!have) {
      return (
        <div style={{ background: tones.warning.bg, color: tones.warning.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>No email on file for {person?.name || 'this person'} — nothing can be chased until we have one.</span>
          <button
            onClick={open}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: font, fontSize: 12, fontWeight: 700, padding: '5px 11px', borderRadius: 8, cursor: 'pointer', background: '#fff', color: tones.warning.fg, border: `1px solid ${tones.warning.border}` }}
          >
            <Mail size={12} /> Add email
          </button>
        </div>
      );
    }
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', marginBottom: 16 }}>
        <Mail size={13} color="#94a3b8" />
        <span>{person.email}</span>
        <button
          onClick={open} title="Change this email"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: '#0e7fe0', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: 0 }}
        >
          <Pencil size={11} /> Edit
        </button>
      </div>
    );
  }

  if (have) return null;
  return (
    <button
      onClick={open} title="No email on file — add one so this person can be chased"
      style={{
        ...chipStyle('warning'), display: 'inline-flex', alignItems: 'center', gap: 4,
        border: `1px solid ${tones.warning.border}`, cursor: 'pointer', fontFamily: font,
      }}
    >
      <Mail size={11} /> add email
    </button>
  );
}
