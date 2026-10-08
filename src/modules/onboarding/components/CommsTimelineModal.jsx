import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Phone, MessageSquare, RefreshCw } from 'lucide-react';
import { tones, chipStyle } from '../../../lib/tokens';
import { BTN } from '../../../lib/buttonStyles';
import ModalShell from './ModalShell';
import { FindingRow } from './ReplyFindings';
import { listCommsTimeline, readRepliesNow } from '../api';

const TYPE = {
  email_out: { label: 'Sent', icon: ArrowUpRight, tone: 'info' },
  email_in: { label: 'Client replied', icon: ArrowDownLeft, tone: 'success' },
  call: { label: 'Call', icon: Phone, tone: 'accent' },
  portal_reply: { label: 'Portal reply', icon: MessageSquare, tone: 'success' },
};

function when(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Long emails start folded to a few lines; quoted history is left in, since
// that's what the client actually saw.
function Body({ text }) {
  const [open, setOpen] = useState(false);
  const clean = String(text || '').trim();
  if (!clean) return null;
  const long = clean.length > 420;
  return (
    <div style={{ fontSize: 13.5, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.5, marginTop: 4 }}>
      {long && !open ? `${clean.slice(0, 420)}…` : clean}
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 'none', color: '#0e7fe0', cursor: 'pointer', fontSize: 13, padding: '0 0 0 4px' }}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/*
  Every contact with the client since the onboarding started, newest first:
  what we sent, what they replied and when, calls, and what Athena read in
  their replies against the things we'd asked for.
*/
export default function CommsTimelineModal({ onboarding, onClose, onChanged }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false);

  const load = useCallback(() => {
    listCommsTimeline(onboarding).then(setEvents).catch((e) => setError(e.message));
  }, [onboarding]);
  useEffect(() => { load(); }, [load]);

  async function readNow() {
    setReading(true); setError(null);
    try { await readRepliesNow(onboarding.id); load(); onChanged?.(); }
    catch (e) { setError(e.message); }
    setReading(false);
  }

  const lastOut = events?.find((e) => e.type === 'email_out');
  const lastIn = events?.find((e) => e.type === 'email_in' || e.type === 'portal_reply');

  return (
    <ModalShell
      title="Comms timeline"
      subtitle={onboarding.entity?.name}
      width={760}
      onClose={onClose}
      footer={(
        <>
          {error && <span style={{ fontSize: 13, color: tones.danger.fg, flex: 1 }}>{error}</span>}
          <button
            onClick={readNow} disabled={reading}
            title="Read this client's new emails for anything we asked for, now rather than at the next quarter-hour"
            style={{ ...BTN.secondary.sm, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <RefreshCw size={11} /> {reading ? 'Reading…' : 'Read replies now'}
          </button>
          <button onClick={onClose} style={{ ...BTN.secondary.md, marginLeft: 'auto' }}>Close</button>
        </>
      )}
    >
      {events && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: '#64748b', marginBottom: 12 }}>
          <span>Last sent: <strong style={{ color: '#0f172a' }}>{lastOut ? when(lastOut.at) : '—'}</strong></span>
          <span>Last heard from them: <strong style={{ color: '#0f172a' }}>{lastIn ? when(lastIn.at) : '—'}</strong></span>
        </div>
      )}
      {!events && !error && <div style={{ fontSize: 14, color: '#64748b' }}>Loading…</div>}
      {events && events.length === 0 && (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>No emails or calls since this onboarding started.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(events || []).map((e) => {
          const t = TYPE[e.type] || TYPE.email_out;
          const Icon = t.icon;
          return (
            <div key={e.key} style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: '1px solid #f1f5f9' }}>
              <div style={{
                width: 26, height: 26, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: tones[t.tone].bg, color: tones[t.tone].fg, border: `1px solid ${tones[t.tone].border}`,
              }}>
                <Icon size={13} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
                  <span style={chipStyle(t.tone)}>{t.label}</span>
                  <span style={{ color: '#0f172a', fontWeight: 600 }}>{e.who}</span>
                  {e.type === 'email_out' && e.to && <span style={{ color: '#94a3b8' }}>to {e.to}</span>}
                  <span style={{ color: '#94a3b8', marginLeft: 'auto' }}>{when(e.at)}</span>
                </div>
                {e.subject && <div style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 3 }}>{e.subject}</div>}
                <Body text={e.body} />
                {e.findings.length > 0 && (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: tones.warning.bg, border: `1px solid ${tones.warning.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: tones.warning.fg }}>In this email, Athena read:</div>
                    {e.findings.map((f) => <FindingRow key={f.id} finding={f} compact onChanged={() => { load(); onChanged?.(); }} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
