import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { tones, pillStyle, chipStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import ModalShell from './ModalShell';
import OnboardingTemplatesModal from './OnboardingTemplatesModal';
import { ContactEditor } from './OnboardingContact';
import { OB_EMAIL_KINDS, renderOnboardingEmail, sendOnboardingClientEmail } from '../api';

const font = "'Outfit', sans-serif";
const input = {
  width: '100%', padding: '7px 10px', fontSize: 14, fontFamily: font, boxSizing: 'border-box',
  border: '1px solid #cbd5e1', borderRadius: 8, color: '#0f172a', background: '#fff',
};
const label = { fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 4, display: 'block' };

/*
  Email the client from the onboarding list. Pick a template, tick what we
  still need, edit, send. It goes to the onboarding contact (Change edits the
  contact itself, so the next email goes there too), from the mailbox picked
  here — info@ unless changed — with the practice signature underneath, and
  is logged on the client and the onboarding.

  An item the client's email appears to have already answered (an open
  reply finding) starts unticked and says so — the point is never to ask a
  client again for something they've sent.
*/
export default function OnboardingEmailModal({ onboarding, onClose, onSent }) {
  const [kind, setKind] = useState('ob_request');
  const [draft, setDraft] = useState(null); // render result
  const [picked, setPicked] = useState([]); // step ids listed in the email
  const [fromMailbox, setFromMailbox] = useState(null); // null = server default (info@)
  const [editingContact, setEditingContact] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const render = useCallback(async (k, stepIds, mailbox) => {
    setBusy(true); setError(null);
    try {
      const r = await renderOnboardingEmail(onboarding.id, k, stepIds, mailbox);
      setDraft(r);
      setPicked(r.listed);
      setSubject(r.subject);
      setText(r.text);
      setEdited(false);
      setFromMailbox(r.from_mailbox);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, [onboarding.id]);

  useEffect(() => { render('ob_request', null, null); }, [render]);

  function confirmRebuild() {
    return !edited || window.confirm('Rebuild the message from the template? Your edits to it will be lost.');
  }

  function chooseKind(k) {
    if (k === kind || !confirmRebuild()) return;
    setKind(k);
    render(k, k === 'blank' ? [] : picked.length ? picked : null, fromMailbox);
  }

  function chooseMailbox(m) {
    if (m === fromMailbox || !confirmRebuild()) return;
    render(kind, picked, m);
  }

  function toggleItem(stepId) {
    if (!confirmRebuild()) return;
    const next = picked.includes(stepId) ? picked.filter((x) => x !== stepId) : [...picked, stepId];
    render(kind, next, fromMailbox);
  }

  async function send() {
    if (!draft?.contact?.email) { setError('The onboarding contact has no email address — add one first.'); return; }
    setSending(true); setError(null);
    try {
      const r = await sendOnboardingClientEmail(onboarding.id, { subject, text, kind, step_ids: picked, from_mailbox: fromMailbox });
      onSent?.(r);
      onClose();
    } catch (e) { setError(e.message); setSending(false); }
  }

  function close() {
    if (edited && !window.confirm('Discard this email?')) return;
    onClose();
  }

  const items = draft?.items || [];
  const contact = draft?.contact;

  return (
    <>
      <ModalShell
        title="Email the client"
        subtitle={onboarding.entity?.name}
        width={760}
        onClose={close}
        footer={(
          <>
            <button
              onClick={() => setTemplatesOpen(true)}
              style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <Pencil size={11} /> Edit templates
            </button>
            {error && <span style={{ fontSize: 13, color: tones.danger.fg, flex: 1 }}>{error}</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={close} style={BTN.secondary.md}>Cancel</button>
              <button onClick={send} disabled={busy || sending} style={{ ...BTN.primary.md, opacity: busy || sending ? 0.6 : 1 }}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {OB_EMAIL_KINDS.map((k) => (
            <button key={k.value} onClick={() => chooseKind(k.value)} style={pillStyle({ tone: 'info', active: kind === k.value })}>
              {k.label}
            </button>
          ))}
        </div>

        {kind !== 'blank' && (
          <div style={{ marginBottom: 14 }}>
            <span style={label}>What we still need {items.length ? `(${items.length} open)` : ''}</span>
            {items.length === 0 && !busy && (
              <div style={{ fontSize: 13.5, color: '#94a3b8' }}>Nothing is outstanding from the client.</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {items.map((it) => (
                <label key={it.step_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: '#334155', cursor: busy ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={picked.includes(it.step_id)} disabled={busy} onChange={() => toggleItem(it.step_id)} style={{ marginTop: 3 }} />
                  <span style={{ flex: 1 }}>
                    {it.label}
                    {it.status === 'pending' && <span style={{ color: '#94a3b8' }}> · not asked yet</span>}
                    {it.finding && (
                      <span style={{ ...chipStyle('warning'), display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
                        <AlertTriangle size={10} />
                        May already be sent {new Date(it.finding.received_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        {it.finding.value ? ` — ${it.finding.value}` : ''}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={label}>
              To — the onboarding contact
              {!editingContact && (
                <button
                  onClick={() => setEditingContact(true)}
                  style={{ background: 'none', border: 'none', color: '#0e7fe0', cursor: 'pointer', fontSize: 12.5, padding: '0 0 0 6px', fontFamily: font }}
                >
                  Change
                </button>
              )}
            </span>
            {!editingContact && (
              <div style={{ ...input, background: '#f8fafc', color: contact?.email ? '#0f172a' : tones.warning.fg }}>
                {contact
                  ? (contact.email ? `${contact.name || contact.first_name || ''} <${contact.email}>` : `${contact.name || 'No contact'} — no email address`)
                  : '…'}
              </div>
            )}
            {draft && !draft.contact_saved && !editingContact && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>Default: {draft.contact_source}</div>
            )}
          </div>
          <div>
            <span style={label}>From</span>
            <select
              style={input}
              value={fromMailbox || ''}
              disabled={busy || !draft}
              onChange={(e) => chooseMailbox(e.target.value)}
            >
              {(draft?.mailboxes || []).map((m) => (
                <option key={m.email} value={m.email}>
                  {m.email}{m.kind === 'personal' ? ' (yours)' : ''}
                </option>
              ))}
            </select>
            {draft?.from_name && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>Shows as {draft.from_name}</div>}
          </div>
        </div>
        {editingContact && draft && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', marginBottom: 12, background: '#f8fafc' }}>
            <ContactEditor
              onboardingId={onboarding.id}
              initial={draft.contact}
              people={draft.people || []}
              onCancel={() => setEditingContact(false)}
              onSaved={() => { setEditingContact(false); if (confirmRebuild()) render(kind, picked, fromMailbox); }}
            />
          </div>
        )}
        <span style={label}>Subject</span>
        <input style={{ ...input, marginBottom: 10 }} value={subject} onChange={(e) => { setSubject(e.target.value); setEdited(true); }} />
        <span style={label}>Message</span>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setEdited(true); }}
          style={{ ...input, minHeight: 260, resize: 'vertical', lineHeight: 1.5, opacity: busy ? 0.6 : 1 }}
        />
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
          The practice signature is added underneath. Items still at To do become “requested” today when this goes. Logged on the client’s Communications tab and the onboarding’s timeline.
        </div>
      </ModalShell>
      {templatesOpen && (
        <OnboardingTemplatesModal
          initialKind={kind === 'blank' ? 'ob_request' : kind}
          onClose={() => setTemplatesOpen(false)}
          onSaved={() => { if (!edited) render(kind, picked, fromMailbox); }}
        />
      )}
    </>
  );
}
