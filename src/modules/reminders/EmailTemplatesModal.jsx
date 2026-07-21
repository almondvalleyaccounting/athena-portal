import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { buildEmailPreview, sampleTemplateVars } from './lib';

/*
  Email templates — review and (for managers) edit the copy that the
  reminders-send edge function actually sends. One row per (comm_type,
  kind) in comm_templates; the sender renders these via {{token}}
  substitution, so this modal is the single place the wording lives.
*/

const font = "'Outfit', sans-serif";
const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 };
const label = { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4, display: 'block' };
const input = {
  width: '100%', padding: '7px 10px', fontSize: 12.5, fontFamily: font,
  border: '1px solid #e5e7eb', borderRadius: 8, boxSizing: 'border-box', color: '#0f172a',
};
const btnGhost = {
  padding: '7px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#334155', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer',
};
const btnPrimary = (on) => ({
  padding: '8px 16px', fontSize: 12.5, fontWeight: 600, fontFamily: font,
  background: on ? '#0e7fe0' : '#e5e7eb', color: on ? '#fff' : '#94a3b8',
  border: 'none', borderRadius: 8, cursor: on ? 'pointer' : 'default',
});

const KINDS = [
  { key: 'promo', label: 'Email 1 · opt-in invitation' },
  { key: 'reminder', label: 'Email 2 · payment details' },
  { key: 'no_utr', label: 'Email 2b · not registered yet' },
];
const TOKENS = ['{{first_name}}', '{{amount}}', '{{due_date}}', '{{payment_ref}}', '{{opt_in_url}}', '{{opt_out_url}}', '{{pay_url}}', '{{pta_url}}'];

export default function EmailTemplatesModal({ commType = 'tax_reminders', onClose }) {
  const { profile } = useAuth();
  const canEdit = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const [kind, setKind] = useState('promo');
  const [rows, setRows] = useState({}); // kind -> { subject, body_html, body_text }
  const [draft, setDraft] = useState({ subject: '', body_html: '', body_text: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase
      .from('comm_templates')
      .select('kind, subject, body_html, body_text')
      .eq('comm_type', commType);
    if (e) { setError(`Could not load templates: ${e.message}`); setLoading(false); return; }
    setRows(Object.fromEntries((data || []).map((r) => [r.kind, r])));
    setLoading(false);
  }, [commType]);

  useEffect(() => { load(); }, [load]);

  // Load the draft when the kind changes or rows arrive.
  useEffect(() => {
    const r = rows[kind];
    setDraft(r ? { subject: r.subject || '', body_html: r.body_html || '', body_text: r.body_text || '' } : { subject: '', body_html: '', body_text: '' });
    setSavedAt(null);
  }, [kind, rows]);

  const dirty = useMemo(() => {
    const r = rows[kind];
    if (!r) return false;
    return draft.subject !== (r.subject || '') || draft.body_html !== (r.body_html || '') || draft.body_text !== (r.body_text || '');
  }, [draft, rows, kind]);

  const preview = useMemo(() => buildEmailPreview(draft, sampleTemplateVars()), [draft]);

  const save = async () => {
    if (!canEdit || !dirty) return;
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const { error: e } = await supabase
      .from('comm_templates')
      .update({ subject: draft.subject, body_html: draft.body_html, body_text: draft.body_text, updated_by: profile?.id || null, updated_at: now })
      .eq('comm_type', commType).eq('kind', kind);
    setSaving(false);
    if (e) { setError(`Could not save: ${e.message}`); return; }
    setRows((cur) => ({ ...cur, [kind]: { kind, ...draft } }));
    setSavedAt(now);
  };

  return (
    <div style={overlayStyle}>
      <div style={{ ...card, width: 1040, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: 20, fontFamily: font }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Email templates</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#64748b', cursor: 'pointer', fontFamily: font }}>×</button>
        </div>

        {!canEdit && (
          <div style={{ ...card, padding: '9px 12px', marginBottom: 12, background: '#f8fafc', color: '#475569', fontSize: 12 }}>
            You can review the templates here. Editing is limited to portal managers.
          </div>
        )}
        {error && (
          <div style={{ ...card, padding: '9px 12px', marginBottom: 12, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: 12.5 }}>{error}</div>
        )}

        {/* kind switch */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {KINDS.map((k) => {
            const active = kind === k.key;
            return (
              <button
                key={k.key}
                onClick={() => setKind(k.key)}
                style={{
                  padding: '6px 14px', fontSize: 12.5, fontWeight: 600, fontFamily: font, borderRadius: 999, cursor: 'pointer',
                  background: active ? '#eff6ff' : '#fff', color: active ? '#1d4ed8' : '#64748b',
                  border: `1px solid ${active ? '#bfdbfe' : '#e5e7eb'}`,
                }}
              >
                {k.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: '#64748b' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* editor */}
            <div style={{ flex: '1 1 440px', minWidth: 320 }}>
              <label style={label}>Subject</label>
              <input
                style={input}
                value={draft.subject}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              />
              <label style={{ ...label, marginTop: 12 }}>Body — HTML</label>
              <textarea
                style={{ ...input, minHeight: 200, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.45, resize: 'vertical' }}
                value={draft.body_html}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, body_html: e.target.value }))}
              />
              <label style={{ ...label, marginTop: 12 }}>Body — plain text</label>
              <textarea
                style={{ ...input, minHeight: 130, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.45, resize: 'vertical' }}
                value={draft.body_text}
                disabled={!canEdit}
                onChange={(e) => setDraft((d) => ({ ...d, body_text: e.target.value }))}
              />
              <div style={{ marginTop: 10, fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
                Tokens:{' '}
                {TOKENS.map((t) => (
                  <code key={t} style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, marginRight: 5, color: '#475569' }}>{t}</code>
                ))}
                <div style={{ marginTop: 4 }}>
                  {kind === 'promo'
                    ? 'Email 1 has no tax figures — opt-in / opt-out buttons use the URL tokens.'
                    : 'Email 2 goes only to opted-in clients; {{payment_ref}} is the client’s UTR + K.'}
                </div>
              </div>
            </div>

            {/* preview */}
            <div style={{ flex: '1 1 420px', minWidth: 300 }}>
              <label style={label}>Preview (sample data)</label>
              <div style={{ fontSize: 12.5, color: '#334155', margin: '2px 0 8px' }}>
                Subject: <strong>{preview.subject}</strong>
              </div>
              <div
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 10px', background: '#fff', maxHeight: 460, overflowY: 'auto' }}
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
          {savedAt && <span style={{ fontSize: 12, color: '#166534', fontWeight: 600 }}>Saved ✓</span>}
          {dirty && !savedAt && <span style={{ fontSize: 12, color: '#92400e' }}>Unsaved changes</span>}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={btnGhost}>Close</button>
          {canEdit && (
            <button onClick={save} disabled={!dirty || saving} style={btnPrimary(dirty && !saving)}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
