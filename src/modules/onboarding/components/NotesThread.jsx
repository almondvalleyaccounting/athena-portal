import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { addNote } from '../api';

const font = "'Outfit', sans-serif";
const inputStyle = {
  padding: '5px 8px', fontSize: 13.5, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 7,
};

export function fmtNoteTime(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/*
  The onboarding's note thread — onboarding_activity rows of kind 'note'.
  One thread, two doors: the pipeline row's comments and the detail screen's
  Notes panel both read and write it. Newest first.

  groupName scopes the thread to one task group (SA, VAT, PAYE …): new notes
  are tagged with it. The caller passes only that group's notes. Without it the
  thread is onboarding-wide and shows every note, group notes chipped with
  their group.
*/
export default function NotesThread({ onboardingId, notes, onAdded, maxHeight = 360, autoFocus = false, groupName = null }) {
  const { profile } = useAuth();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const sorted = [...(notes || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  async function submit() {
    const body = text.trim();
    if (!body) return;
    setSaving(true); setError(null);
    try {
      await addNote(onboardingId, body, { actorId: profile?.id, groupName });
      setText('');
      onAdded?.();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <textarea
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
          placeholder={groupName ? `Add a ${groupName} note…  (Ctrl+Enter to post)` : 'Add a note…  (Ctrl+Enter to post)'}
          style={{ ...inputStyle, flex: 1, minHeight: 40, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <Btn onClick={submit} disabled={saving || !text.trim()} className="self-start">
          <Send size={14} />
        </Btn>
      </div>
      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight, overflowY: 'auto' }}>
        {sorted.length === 0 && <div style={{ fontSize: 13.5, color: '#64748b' }}>No notes yet.</div>}
        {sorted.map((n) => (
          <div key={n.id} style={{
            fontSize: 14, background: '#fff', border: '1px solid #e2e8f0',
            borderLeft: '3px solid #0e7fe0', borderRadius: 8, padding: '9px 12px',
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 600, color: '#0f172a' }}>{n.author?.name || 'Athena'}</span>
              <span style={{ color: '#64748b' }}>{fmtNoteTime(n.created_at)}</span>
              {!groupName && n.group_name && <span style={{ ...chipStyle('info'), marginLeft: 'auto' }}>{n.group_name}</span>}
            </div>
            <div style={{ color: '#0f172a', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{n.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
