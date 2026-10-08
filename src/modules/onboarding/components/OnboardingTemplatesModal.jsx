import React, { useEffect, useState } from 'react';
import { tones, pillStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import { useAuth } from '../../../shell/AppShell';
import ModalShell from './ModalShell';
import { OB_EMAIL_KINDS, listOnboardingTemplates, saveOnboardingTemplate } from '../api';

const font = "'Outfit', sans-serif";
const input = {
  width: '100%', padding: '7px 10px', fontSize: 14, fontFamily: font, boxSizing: 'border-box',
  border: '1px solid #cbd5e1', borderRadius: 8, color: '#0f172a',
};
const TOKENS = ['{{first_name}}', '{{opener}}', '{{client_name}}', '{{items}}', '{{sender_name}}', '{{sender_first_name}}', '{{from_email}}'];

// The wording of the onboarding emails (comm_templates, comm_type
// 'onboarding'). Plain text — the email goes out looking hand-typed.
export default function OnboardingTemplatesModal({ initialKind = 'ob_request', onClose, onSaved }) {
  const { profile } = useAuth();
  const kinds = [...OB_EMAIL_KINDS.filter((k) => k.value !== 'blank'), { value: 'ob_signature', label: 'Signature' }];
  const isSig = kind === 'ob_signature';
  const [kind, setKind] = useState(initialKind);
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState({ subject: '', body_text: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    listOnboardingTemplates()
      .then((data) => setRows(Object.fromEntries(data.map((r) => [r.kind, r]))))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const r = rows?.[kind];
    setDraft({ subject: r?.subject || '', body_text: r?.body_text || '' });
    setSaved(false);
  }, [kind, rows]);

  const current = rows?.[kind];
  const dirty = Boolean(current) && (draft.subject !== current.subject || draft.body_text !== current.body_text);

  function pick(k) {
    if (k === kind) return;
    if (dirty && !window.confirm('Discard your changes to this template?')) return;
    setKind(k);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await saveOnboardingTemplate(kind, draft, { actorId: profile?.id });
      setRows((r) => ({ ...r, [kind]: { ...r[kind], ...draft } }));
      setSaved(true);
      onSaved?.();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  function close() {
    if (dirty && !window.confirm('Discard your changes to this template?')) return;
    onClose();
  }

  return (
    <ModalShell
      title="Onboarding email templates"
      width={720}
      onClose={close}
      footer={(
        <>
          {error && <span style={{ fontSize: 13, color: tones.danger.fg, flex: 1 }}>{error}</span>}
          {saved && !dirty && <span style={{ fontSize: 13, color: tones.success.fg, fontWeight: 600 }}>Saved</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={close} style={BTN.secondary.md}>Close</button>
            <button onClick={save} disabled={!dirty || saving} style={{ ...BTN.primary.md, opacity: !dirty || saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {kinds.map((k) => (
          <button key={k.value} onClick={() => pick(k.value)} style={pillStyle({ tone: 'info', active: kind === k.value })}>
            {k.label}
          </button>
        ))}
      </div>
      {!rows ? (
        <div style={{ fontSize: 14, color: '#64748b' }}>Loading…</div>
      ) : (
        <>
          {!isSig && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>Subject</div>
              <input style={{ ...input, marginBottom: 10 }} value={draft.subject} onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))} />
            </>
          )}
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
            {isSig ? 'Signature — added under every onboarding email' : 'Message'}
          </div>
          <textarea
            value={draft.body_text}
            onChange={(e) => setDraft((d) => ({ ...d, body_text: e.target.value }))}
            style={{ ...input, minHeight: isSig ? 140 : 280, resize: 'vertical', lineHeight: 1.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13 }}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8', lineHeight: 1.8 }}>
            Tokens:{' '}
            {TOKENS.map((t) => (
              <code key={t} style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, marginRight: 5, color: '#475569' }}>{t}</code>
            ))}
            <div>{'{{first_name}}'} is the onboarding contact’s first name. {'{{items}}'} is the ticked list from the email screen. {'{{from_email}}'} is the mailbox it’s sent from. The signature goes under every email automatically.</div>
          </div>
        </>
      )}
    </ModalShell>
  );
}
