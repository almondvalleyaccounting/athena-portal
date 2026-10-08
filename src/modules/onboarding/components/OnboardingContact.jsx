import React, { useCallback, useEffect, useState } from 'react';
import { UserRound, Pencil } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import { getOnboardingContact, setOnboardingContact } from '../api';

const font = "'Outfit', sans-serif";
const input = {
  width: '100%', padding: '6px 9px', fontSize: 13.5, fontFamily: font, boxSizing: 'border-box',
  border: '1px solid #cbd5e1', borderRadius: 7, color: '#0f172a', background: '#fff',
};
const label = { fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 3, display: 'block' };

/*
  The onboarding contact form: pick someone on the client to start from, then
  adjust name, first name (what "Hi …" uses), email and phone. Used by the
  card on the onboarding screen and inline in the email modal.
*/
export function ContactEditor({ onboardingId, initial, people = [], onSaved, onCancel }) {
  const [form, setForm] = useState({
    person_id: initial?.person_id || '', name: initial?.name || '', first_name: initial?.first_name || '',
    email: initial?.email || '', phone: initial?.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function pickPerson(id) {
    const p = people.find((x) => x.person_id === id);
    setForm(p
      ? { person_id: p.person_id, name: p.name || '', first_name: p.first_name || '', email: p.email || '', phone: p.phone || '' }
      : { ...form, person_id: '' });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await setOnboardingContact(onboardingId, { ...form, person_id: form.person_id || null });
      onSaved?.();
    } catch (e) { setError(e.message); setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {people.length > 0 && (
        <div>
          <span style={label}>Start from someone on the client</span>
          <select style={input} value={form.person_id} onChange={(e) => pickPerson(e.target.value)}>
            <option value="">— someone else —</option>
            {people.map((p) => (
              <option key={p.person_id} value={p.person_id}>
                {p.name}{p.role ? ` (${p.role.replace(/_/g, ' ')})` : ''}{p.email ? '' : ' — no email'}
              </option>
            ))}
          </select>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
        <div><span style={label}>Name</span><input style={input} value={form.name} onChange={set('name')} /></div>
        <div><span style={label}>First name (for “Hi …”)</span><input style={input} value={form.first_name} onChange={set('first_name')} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
        <div><span style={label}>Email</span><input style={input} type="email" value={form.email} onChange={set('email')} /></div>
        <div><span style={label}>Phone</span><input style={input} value={form.phone} onChange={set('phone')} /></div>
      </div>
      {error && <div style={{ fontSize: 13, color: tones.danger.fg }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {onCancel && <button onClick={onCancel} style={BTN.secondary.sm}>Cancel</button>}
        <button onClick={save} disabled={saving} style={{ ...BTN.primary.sm, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save contact'}
        </button>
      </div>
    </div>
  );
}

// The card on the onboarding screen.
export default function OnboardingContactCard({ onboardingId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    getOnboardingContact(onboardingId).then(setData).catch((e) => setError(e.message));
  }, [onboardingId]);
  useEffect(() => { load(); }, [load]);

  const c = data?.contact;
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <UserRound size={14} color="#64748b" />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#475569', flex: 1 }}>Onboarding contact</span>
        {data && !data.saved && <span style={chipStyle('neutral')} title="Not saved yet — this is the default">default: {data.source}</span>}
        {data && !editing && (
          <button onClick={() => setEditing(true)} style={{ ...BTN.secondary.sm, padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Pencil size={11} /> Edit
          </button>
        )}
      </div>
      {error && <div style={{ fontSize: 13, color: tones.danger.fg }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 13.5, color: '#94a3b8' }}>Loading…</div>}
      {data && !editing && (
        <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, color: '#0f172a' }}>{c?.name || 'No one yet'}</div>
          <div>{c?.email || <span style={{ color: tones.warning.fg }}>No email — onboarding emails can’t be sent</span>}</div>
          {c?.phone && <div>{c.phone}</div>}
          <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Onboarding emails go here and start “Hi {c?.first_name || 'there'},”</div>
        </div>
      )}
      {data && editing && (
        <ContactEditor
          onboardingId={onboardingId}
          initial={c}
          people={data.people || []}
          onCancel={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
