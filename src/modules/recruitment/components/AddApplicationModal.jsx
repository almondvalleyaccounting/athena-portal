import React, { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { backdrop, modal, fieldLabel, input, btn, font, SOURCES } from '../recruitmentShared';

// Add an applicant to a vacancy's pipeline. Captures the person + how they
// applied; the data layer finds-or-creates the shared candidate record by
// email so re-applicants collapse onto one person.
export default function AddApplicationModal({ vacancyTitle, onClose, onAdd }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [cvUrl, setCvUrl] = useState('');
  const [source, setSource] = useState('');
  const [coverNote, setCoverNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    if (!fullName.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        candidate: {
          full_name: fullName.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          location: location.trim() || null,
          linkedin_url: linkedin.trim() || null,
          cv_url: cvUrl.trim() || null,
        },
        source: source || null,
        coverNote: coverNote.trim() || null,
      });
    } catch (e) {
      setError(e.message || 'Could not add applicant');
      setSaving(false);
    }
  }

  const half = { display: 'flex', gap: 10 };
  const col = { flex: 1, minWidth: 0 };

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 520, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
          <UserPlus size={16} color="#0e7fe0" /> Add applicant
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>to {vacancyTitle}</div>

        <label style={fieldLabel}>Full name *</label>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={input} placeholder="Jane Smith" autoFocus />

        <div style={{ ...half, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} style={input} placeholder="jane@example.com" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} style={input} placeholder="07…" />
          </div>
        </div>

        <div style={{ ...half, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>Location</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} style={input} placeholder="Livingston" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>Source</label>
            <select value={source} onChange={(e) => setSource(e.target.value)} style={input}>
              <option value="">—</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={{ ...half, marginTop: 12 }}>
          <div style={col}>
            <label style={fieldLabel}>LinkedIn URL</label>
            <input value={linkedin} onChange={(e) => setLinkedin(e.target.value)} style={input} placeholder="https://…" />
          </div>
          <div style={col}>
            <label style={fieldLabel}>CV link</label>
            <input value={cvUrl} onChange={(e) => setCvUrl(e.target.value)} style={input} placeholder="Drive / URL" />
          </div>
        </div>

        <label style={{ ...fieldLabel, marginTop: 12 }}>Cover note</label>
        <textarea value={coverNote} onChange={(e) => setCoverNote(e.target.value)} rows={3}
          style={{ ...input, resize: 'vertical' }} placeholder="Anything they said when applying…" />

        {error && <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 10 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btn('ghost')}>Cancel</button>
          <button onClick={submit} disabled={!fullName.trim() || saving}
            style={{ ...btn('primary'), opacity: (!fullName.trim() || saving) ? 0.6 : 1 }}>
            {saving ? 'Adding…' : 'Add to pipeline'}
          </button>
        </div>
      </div>
    </div>
  );
}
