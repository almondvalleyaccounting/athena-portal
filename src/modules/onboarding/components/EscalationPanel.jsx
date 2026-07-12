import React, { useState } from 'react';
import { PhoneCall, PauseCircle, Archive, RotateCcw } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import { updateOnboarding, sendOnboardingEmail, addNote } from '../api';

const font = "'Outfit', sans-serif";

const STAGE = {
  call_needed: { label: 'CALL NEEDED', tone: 'danger', blurb: 'Chaser emails exhausted with no response — time for a phone call.' },
  call_made: { label: 'CALL MADE', tone: 'warning', blurb: 'Call attempted. If still no engagement, send the pause email.' },
  paused: { label: 'PAUSED', tone: 'neutral', blurb: 'Pause email sent — no more chasers. Any portal reply or upload resumes automatically.' },
  offboard_due: { label: 'OFFBOARD DUE', tone: 'danger', blurb: 'Paused past the offboard window. Decide: archive, or resume chasing.' },
};

/*
  Escalation ladder: 2 chasers → call (configurable assignee) → pause email
  → offboard after a configurable quiet period. The chaser engine moves the
  status forward; client portal activity resets it to none automatically.
*/
export default function EscalationPanel({ ob, onChanged }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const stage = STAGE[ob.escalation_status];
  if (!stage) return null; // 'none' — nothing to show

  async function act(fn, okText) {
    setBusy(true); setMsg(null);
    try { await fn(); if (okText) setMsg({ tone: 'success', text: okText }); onChanged?.(); }
    catch (e) { setMsg({ tone: 'danger', text: e.message }); }
    setBusy(false);
  }

  const btn = (bg, fg, border) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px',
    fontSize: 12, fontWeight: 600, fontFamily: font, background: bg, color: fg,
    border: border ? `1px solid ${border}` : 'none', borderRadius: 8, cursor: 'pointer',
  });

  return (
    <div style={{ background: '#fff', border: `1px solid ${tones[stage.tone].border}`, borderRadius: 12, padding: '14px 18px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={chipStyle(stage.tone)}>{stage.label}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {ob.escalated_at ? `escalated ${new Date(ob.escalated_at).toLocaleDateString('en-GB')}` : ''}
          {ob.paused_at ? ` · paused ${new Date(ob.paused_at).toLocaleDateString('en-GB')}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 10, lineHeight: 1.5 }}>{stage.blurb}</div>
      {msg && <div style={{ fontSize: 12, color: tones[msg.tone].fg, marginBottom: 8 }}>{msg.text}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ob.escalation_status === 'call_needed' && (
          <button disabled={busy} style={btn(tones.info.bg, tones.info.fg, tones.info.border)} onClick={() => act(async () => {
            const note = window.prompt('Call outcome (goes on the timeline):', 'No answer, left a voicemail');
            if (note === null) throw new Error('Cancelled');
            await addNote(ob.id, `📞 Call made: ${note}`, { actorId: profile?.id });
            await updateOnboarding(ob.id, { escalation_status: 'call_made' });
          }, 'Call logged.')}>
            <PhoneCall size={13} /> Log call
          </button>
        )}
        {['call_needed', 'call_made'].includes(ob.escalation_status) && (
          <button disabled={busy} style={btn(tones.warning.bg, tones.warning.fg, tones.warning.border)} onClick={() => act(async () => {
            if (!window.confirm('Send the "we\'ll stop pestering you" email and pause all chasing for this client?')) throw new Error('Cancelled');
            await sendOnboardingEmail(ob.id, 'pause');
          }, 'Pause email sent — chasing stopped.')}>
            <PauseCircle size={13} /> Send pause email
          </button>
        )}
        {ob.escalation_status === 'offboard_due' && (
          <button disabled={busy} style={btn(tones.danger.solid, '#fff')} onClick={() => act(async () => {
            if (!window.confirm('Offboard this client? The onboarding will be archived (cancelled). This is recorded on the timeline.')) throw new Error('Cancelled');
            await updateOnboarding(ob.id, { status: 'cancelled' }, {
              actorId: profile?.id,
              logBody: 'Offboarded: no response after chasers, call and pause period — onboarding archived.',
            });
          }, 'Offboarded and archived.')}>
            <Archive size={13} /> Offboard & archive
          </button>
        )}
        <button disabled={busy} style={btn('#fff', '#64748b', '#cbd5e1')} onClick={() => act(async () => {
          await updateOnboarding(ob.id, { escalation_status: 'none', paused_at: null }, {
            actorId: profile?.id, logBody: 'Escalation reset — chasing resumes.',
          });
        }, 'Reset — chasing resumes.')}>
          <RotateCcw size={13} /> Resume chasing
        </button>
      </div>
    </div>
  );
}
