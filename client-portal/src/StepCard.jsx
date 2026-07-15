import React, { useState } from 'react';
import { theme as t } from './theme';

/*
  One interactive card per client step — every status is actionable, not just
  waiting_client. Actions map onto backend RPCs:
    upload / photo  → storage upload + portal_register_document (step → received)
    "I've done this" → portal_step_action:
        did it directly            → done_claim   (step → received)
        posted / emailed / drop-in → sent_elsewhere (step → received, notifies
                                     info@ + the onboarding owner)
    "Not arrived yet" (only for steps with an expected turnaround)
                     → portal_step_action not_received (logged + owner notified)
    "Message us"     → portal_step_reply
*/

export const STEP_BADGE = {
  complete: { label: 'Done — thank you', bg: '#dcfce7', fg: '#166534' },
  waiting_client: { label: 'Needed from you', bg: '#fef3c7', fg: '#92400e' },
  received: { label: "With us — being checked", bg: '#e0f2fe', fg: '#155e75' },
  pending: { label: 'Coming up', bg: '#f1f5f9', fg: '#475569' },
  waiting_external: { label: 'In progress', bg: '#e0e7ff', fg: '#3730a3' },
  blocked: { label: 'Needs attention', bg: '#fef3c7', fg: '#92400e' },
};

const INFO_BADGE = {
  complete: { label: 'Done', bg: '#dcfce7', fg: '#166534' },
  waiting_external: { label: 'In hand — no action needed', bg: '#e0e7ff', fg: '#3730a3' },
  pending: { label: 'Coming up — nothing needed', bg: '#f1f5f9', fg: '#475569' },
};

const SENT_OPTIONS = [
  { key: 'direct', label: 'I did this directly / online', action: 'done_claim', prefix: '' },
  { key: 'posted', label: "I've posted it to you", action: 'sent_elsewhere', prefix: 'Posted it. ' },
  { key: 'emailed', label: "I've emailed it separately", action: 'sent_elsewhere', prefix: 'Emailed it separately. ' },
  { key: 'dropoff', label: "I'll drop it into the office", action: 'sent_elsewhere', prefix: 'Dropping it into the office. ' },
];

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function timelineHint(step) {
  const isInfo = step.owner_type && step.owner_type !== 'client';
  if (step.status === 'received') return 'We have it — we’ll confirm once it’s checked.';
  if (['waiting_client', 'waiting_external'].includes(step.status) && step.requested_at && step.expected_days != null) {
    const due = new Date(step.requested_at);
    due.setDate(due.getDate() + step.expected_days);
    return due < new Date()
      ? 'Taking a little longer than usual — we’re chasing it.'
      : `Usually takes ~${step.expected_days} days — expected around ${fmtDate(due)}.`;
  }
  if (step.status === 'pending' && !isInfo && step.portal_mode !== 'external') {
    return 'Not needed just yet — but you can get ahead of it below.';
  }
  return null;
}

const actionBtn = (primary) => ({
  fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 10,
  padding: '9px 14px', cursor: 'pointer', minHeight: 38,
  color: primary ? '#fff' : t.tealText,
  background: primary ? t.teal : t.tealSoft,
  transition: 'transform 0.15s ease, opacity 0.15s ease',
});

export default function StepCard({ step, entityId, onReply, onUpload, onAction, delay = 0 }) {
  const [panel, setPanel] = useState(null); // null | 'done' | 'message' | 'notArrived'
  const [message, setMessage] = useState('');
  const [doneChoice, setDoneChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [flash, setFlash] = useState(null); // confirmation text after an action

  // Staff/system steps surfaced to the client (e.g. professional clearance)
  // are information only; 'external' steps complete in another system (BM
  // e-sign, QuickBooks DD link) so uploads make no sense for them.
  const isInfo = step.owner_type && step.owner_type !== 'client';
  const isExternal = step.portal_mode === 'external';
  const badge = (isInfo && INFO_BADGE[step.status]) || STEP_BADGE[step.status] || STEP_BADGE.pending;
  const needsYou = !isInfo && ['waiting_client', 'blocked'].includes(step.status);
  const upcoming = !isInfo && step.status === 'pending';
  const withUs = !isInfo && step.status === 'received';
  const actionable = needsYou || upcoming;
  const canUpload = actionable && !isExternal;
  const hint = step.portal_hint || timelineHint(step);
  const docs = Number(step.documents || 0);

  function closePanels() { setPanel(null); setDoneChoice(null); setMessage(''); }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    const ok = await onUpload(step.id, entityId, file);
    setUploading(false);
    if (ok) { setFlash('Received — thank you. We’ll take it from here.'); closePanels(); }
  }

  async function submitDone() {
    const choice = SENT_OPTIONS.find((o) => o.key === doneChoice);
    if (!choice) return;
    setBusy(true);
    const note = `${choice.prefix}${message.trim()}`.trim();
    const ok = await onAction(step.id, choice.action, note || null);
    setBusy(false);
    if (ok) {
      setFlash(choice.action === 'sent_elsewhere'
        ? 'Thank you — we’ve let the office know to look out for it.'
        : 'Thank you — we’ll verify it and mark it complete.');
      closePanels();
    }
  }

  async function submitNotArrived() {
    setBusy(true);
    const ok = await onAction(step.id, 'not_received', message.trim() || null);
    setBusy(false);
    if (ok) { setFlash('Noted — we’ll look into it and keep you posted.'); closePanels(); }
  }

  async function submitMessage() {
    if (!message.trim()) return;
    setBusy(true);
    const ok = await onReply(step.id, message.trim());
    setBusy(false);
    if (ok) { setFlash('Message sent — the team will come back to you.'); closePanels(); }
  }

  const inputStyle = {
    width: '100%', minHeight: 60, padding: '10px 12px', fontSize: 14,
    border: `1px solid ${t.border}`, borderRadius: 10, resize: 'vertical', boxSizing: 'border-box',
  };

  return (
    <div className="fade-up" style={{
      animationDelay: `${delay}ms`,
      border: `1px solid ${needsYou ? '#fcd34d' : t.border}`, borderRadius: 14,
      padding: '14px 16px',
      background: needsYou ? '#fffdf5' : upcoming ? '#fafcfd' : '#fff',
      opacity: upcoming ? 0.92 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14.5, color: t.text, lineHeight: 1.5, flex: '1 1 220px' }}>
          {step.status === 'complete' && <span className="pop-in" style={{ color: t.success, fontWeight: 700, marginRight: 6, display: 'inline-block' }}>✓</span>}
          {step.label}
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: badge.bg, color: badge.fg, whiteSpace: 'nowrap' }}>
          {badge.label}
        </span>
      </div>

      {(hint || docs > 0) && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: t.muted, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {hint && <span>{hint}</span>}
          {docs > 0 && <span style={{ color: t.tealText }}>📎 {docs} file{docs === 1 ? '' : 's'} received</span>}
        </div>
      )}

      {flash && (
        <div className="pop-in" style={{ marginTop: 10, fontSize: 13, color: t.successText, background: t.successSoft, borderRadius: 10, padding: '8px 12px' }}>
          {flash}
        </div>
      )}

      {(actionable || withUs || isInfo) && !flash && (
        <div style={{ marginTop: 10 }}>
          {!panel && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(canUpload || withUs) && (
                <>
                  <label style={{ ...actionBtn(true), opacity: uploading ? 0.7 : 1, display: 'inline-flex', alignItems: 'center' }}>
                    {uploading ? 'Uploading…' : '📷 Photo'}
                    <input type="file" accept="image/*" capture="environment" onChange={handleFile} disabled={uploading} style={{ display: 'none' }} />
                  </label>
                  <label style={{ ...actionBtn(false), opacity: uploading ? 0.7 : 1, display: 'inline-flex', alignItems: 'center' }}>
                    📎 Upload
                    <input type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" onChange={handleFile} disabled={uploading} style={{ display: 'none' }} />
                  </label>
                </>
              )}
              {actionable && isExternal && (
                <button onClick={() => setPanel('done')} style={actionBtn(true)}>✅ I've done this</button>
              )}
              {actionable && !isExternal && (
                <button onClick={() => setPanel('done')} style={actionBtn(false)}>✅ I've done this</button>
              )}
              {actionable && !isExternal && step.expected_days != null && (
                <button onClick={() => setPanel('notArrived')} style={actionBtn(false)}>🕗 Not arrived yet</button>
              )}
              <button onClick={() => setPanel('message')} style={{ ...actionBtn(false), background: 'none', color: t.muted }}>💬 Message us</button>
            </div>
          )}

          {panel === 'done' && isExternal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, color: t.text }}>
                Already done this? We'll verify it on our side and mark it complete.
              </div>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Anything we should know? (optional)" style={inputStyle} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={async () => {
                    setBusy(true);
                    const ok = await onAction(step.id, 'done_claim', message.trim() || null);
                    setBusy(false);
                    if (ok) { setFlash('Brilliant — we’ll double-check and tick it off.'); closePanels(); }
                  }}
                  disabled={busy}
                  style={{ ...actionBtn(true), background: t.navy, opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? 'Sending…' : 'Confirm'}
                </button>
                <button onClick={closePanels} style={{ ...actionBtn(false), background: 'none', color: t.muted }}>Cancel</button>
              </div>
            </div>
          )}

          {panel === 'done' && !isExternal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>How did you send it?</div>
              {SENT_OPTIONS.map((o) => (
                <label key={o.key} style={{
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: t.text,
                  border: `1px solid ${doneChoice === o.key ? t.teal : t.border}`, borderRadius: 10,
                  padding: '10px 12px', cursor: 'pointer', background: doneChoice === o.key ? t.tealSoft : '#fff',
                }}>
                  <input type="radio" name={`done-${step.id}`} checked={doneChoice === o.key} onChange={() => setDoneChoice(o.key)} />
                  {o.label}
                </label>
              ))}
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Anything we should know? (optional)" style={inputStyle} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={submitDone} disabled={busy || !doneChoice} style={{ ...actionBtn(true), background: t.navy, opacity: busy || !doneChoice ? 0.6 : 1 }}>
                  {busy ? 'Sending…' : 'Confirm'}
                </button>
                <button onClick={closePanels} style={{ ...actionBtn(false), background: 'none', color: t.muted }}>Cancel</button>
              </div>
            </div>
          )}

          {panel === 'notArrived' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, color: t.text }}>
                We'll chase this from our side. Anything useful to add?
              </div>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. nothing in the post yet / I may have missed it" style={inputStyle} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={submitNotArrived} disabled={busy} style={{ ...actionBtn(true), background: t.navy, opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Sending…' : 'Let us know'}
                </button>
                <button onClick={closePanels} style={{ ...actionBtn(false), background: 'none', color: t.muted }}>Cancel</button>
              </div>
            </div>
          )}

          {panel === 'message' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={message} onChange={(e) => setMessage(e.target.value)} autoFocus
                placeholder="e.g. a question about this step, or anything we should know"
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={submitMessage} disabled={busy || !message.trim()} style={{ ...actionBtn(true), background: t.navy, opacity: busy || !message.trim() ? 0.6 : 1 }}>
                  {busy ? 'Sending…' : 'Send to the team'}
                </button>
                <button onClick={closePanels} style={{ ...actionBtn(false), background: 'none', color: t.muted }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
