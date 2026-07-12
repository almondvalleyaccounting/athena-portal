import React, { useState } from 'react';
import { HeartHandshake, Send } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { sendOnboardingEmail, updateOnboarding } from '../api';

const font = "'Outfit', sans-serif";
const input = {
  padding: '5px 8px', fontSize: 12, fontFamily: font, background: '#fff',
  border: '1px solid #cbd5e1', borderRadius: 7,
};

/*
  3-month client check-in. checkin_due defaults to started_at + 3 months.
  Process: each handover-area owner drops a line of feedback here, then the
  check-in email goes to the client (onboarding-emails kind=checkin) — a
  simple "how's everything going from your side?". Feedback stays internal
  (onboardings.checkin_feedback jsonb) — it's context for whoever handles
  the client's reply.
*/
export default function CheckinPanel({ ob, staff, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const feedback = ob.checkin_feedback || {};
  const areas = (ob.handovers || []).map((h) => h.area);
  const due = ob.checkin_due && !ob.checkin_sent_at && new Date(ob.checkin_due) <= new Date();
  const staffName = (id) => staff.find((s) => s.id === id)?.name;

  async function save(patch, logBody) {
    setBusy(true); setMsg(null);
    try { await updateOnboarding(ob.id, patch, { actorId: profile?.id, logBody }); onChanged?.(); }
    catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  function saveAreaNote(area, note) {
    const next = { ...feedback, areas: { ...(feedback.areas || {}), [area]: note || undefined } };
    save({ checkin_feedback: next });
  }

  async function sendCheckin() {
    if (!window.confirm('Send the 3-month check-in email to the client now?')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await sendOnboardingEmail(ob.id, 'checkin');
      setMsg({ tone: 'success', text: `Check-in sent to ${r.to}.` });
      onChanged?.();
    } catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${due ? tones.warning.border : '#e5e7eb'}`, borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <HeartHandshake size={14} color="#64748b" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          3-month check-in
        </span>
        {ob.checkin_sent_at && <span style={chipStyle('success')}>sent</span>}
        {due && <span style={chipStyle('warning')}>DUE</span>}
      </div>

      {ob.checkin_sent_at ? (
        <div style={{ fontSize: 12.5, color: '#475569' }}>
          Check-in email sent {new Date(ob.checkin_sent_at).toLocaleDateString('en-GB')} — watch for the client's reply.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
            Gather a line of feedback from each area owner, then send the client a friendly
            "how's it all going?" email.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>Due</span>
            <input
              type="date" style={input} value={ob.checkin_due || ''} disabled={busy}
              onChange={(e) => save({ checkin_due: e.target.value || null })}
            />
          </div>

          {areas.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
              {areas.map((area) => {
                const owner = (ob.handovers || []).find((h) => h.area === area);
                const ownerName = staffName(owner?.handover_to || owner?.owner_id);
                return (
                  <div key={area}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: '#475569', marginBottom: 3 }}>
                      {area}{ownerName ? ` — ${ownerName}` : ''}
                    </div>
                    <textarea
                      defaultValue={feedback.areas?.[area] || ''}
                      placeholder="How is it going in this area? (internal)"
                      onBlur={(e) => { if (e.target.value !== (feedback.areas?.[area] || '')) saveAreaNote(area, e.target.value); }}
                      style={{ ...input, width: '100%', minHeight: 36, resize: 'vertical', boxSizing: 'border-box' }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          <button
            disabled={busy}
            onClick={sendCheckin}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', fontSize: 12, fontWeight: 600, fontFamily: font, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
          >
            <Send size={12} /> Send check-in email
          </button>
        </>
      )}
      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
