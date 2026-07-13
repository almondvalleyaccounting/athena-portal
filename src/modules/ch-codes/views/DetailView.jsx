import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { chipStyle, tones } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import {
  getChCodeRequest, CH_CODE_STATUSES, recordDecision, recordIdPoaReceived,
  recordCodeReceived, markEnteredOnBm, resendOffer, escalateNow, addNote,
  markStalled, recordClientReply,
} from '../api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const btnGhost = {
  padding: '8px 14px', fontSize: 13, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer',
};

function statusMeta(value) {
  return CH_CODE_STATUSES.find((s) => s.value === value) || CH_CODE_STATUSES[0];
}

const ACTIVITY_TONE = {
  email_out: '#0e7fe0', system: '#94a3b8', status_change: '#0f172a', client_reply: '#059669', note: '#64748b',
};

export default function DetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [req, setReq] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [replyInput, setReplyInput] = useState('');

  const load = () => getChCodeRequest(id).then(setReq).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (error && !req) return <div style={{ padding: 24, color: tones.danger.fg }}>Failed to load: {error}</div>;
  if (!req) return <div style={{ padding: 24, color: '#64748b' }}>Loading…</div>;

  const meta = statusMeta(req.status);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 900 }}>
      <button
        onClick={() => navigate('/ch-codes')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: font }}
      >
        <ArrowLeft size={14} /> Back to pipeline
      </button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{req.person?.name || 'Unknown'}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>{req.entity?.name} · Owner: {req.owner?.name || 'unassigned'}</p>
        </div>
        <span style={chipStyle(meta.tone)}>{meta.label}</span>
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {!req.person?.email && !['entered_on_bm', 'stalled'].includes(req.status) && (
        <div style={{ background: tones.warning.bg, color: tones.warning.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          No email on file for {req.person?.name} — chasers can't reach them until an email address is added to their people record.
        </div>
      )}
      {req.escalation_status === 'call_needed' && (
        <div style={{ background: tones.danger.bg, color: tones.danger.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          📞 2 chases sent with no response — Sophie to call {req.person?.name}.
        </div>
      )}
      {req.escalation_status === 'escalated_tracy' && (
        <div style={{ background: tones.danger.bg, color: tones.danger.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          🚨 Escalated to Tracy — no response since the call flag.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {req.status === 'pending_offer' && (
              <div style={{ fontSize: 13, color: '#64748b' }}>Offer not sent yet — goes out on the next chase run.</div>
            )}
            {req.status === 'awaiting_decision' && (
              <>
                <Btn onClick={() => run(() => recordDecision(req, 'paid', { actorId: profile?.id }))} disabled={busy}>
                  Record decision: paid (£20+VAT) — creates &amp; sends invoice
                </Btn>
                <button style={btnGhost} onClick={() => run(() => recordDecision(req, 'self', { actorId: profile?.id }))} disabled={busy}>
                  Record decision: self-verify
                </button>
              </>
            )}
            {req.status === 'awaiting_id_poa' && (
              <Btn onClick={() => run(() => recordIdPoaReceived(req.id, { actorId: profile?.id }))} disabled={busy}>
                Mark ID/POA received &amp; verified
              </Btn>
            )}
            {['awaiting_code', 'awaiting_id_poa'].includes(req.status) && (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={codeInput} onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="FT5-15ED-7JY5"
                  style={{ flex: 1, padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8 }}
                />
                <button
                  style={btnGhost} disabled={busy || !codeInput.trim()}
                  onClick={() => run(async () => { await recordCodeReceived(req, codeInput, { actorId: profile?.id }); setCodeInput(''); })}
                >
                  Save code
                </button>
              </div>
            )}
            {req.status === 'code_received' && (
              <Btn onClick={() => run(() => markEnteredOnBm(req.id, { actorId: profile?.id }))} disabled={busy}>
                Mark entered on BrightManager
              </Btn>
            )}
            {req.status === 'entered_on_bm' && (
              <div style={{ fontSize: 13, color: tones.success.fg }}>✅ Done — code entered on BM.</div>
            )}

            {!['entered_on_bm', 'stalled'].includes(req.status) && (
              <>
                <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 6, paddingTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={btnGhost} onClick={() => run(() => resendOffer(req.id, { actorId: profile?.id }))} disabled={busy}>Reset chase count</button>
                  <button style={btnGhost} onClick={() => run(() => escalateNow(req.id, { actorId: profile?.id }))} disabled={busy}>Escalate now</button>
                  <button style={{ ...btnGhost, color: tones.danger.fg }} onClick={() => run(() => markStalled(req.id, { actorId: profile?.id }))} disabled={busy}>Mark stalled</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Log a client reply / note</div>
          <textarea
            value={replyInput} onChange={(e) => setReplyInput(e.target.value)}
            placeholder="Paste or summarise what the client said in an email/call…"
            rows={3}
            style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              style={btnGhost} disabled={busy || !replyInput.trim()}
              onClick={() => run(async () => { await recordClientReply(req.id, replyInput, { actorId: profile?.id }); setReplyInput(''); })}
            >
              Log as client reply
            </button>
          </div>
          <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 12, paddingTop: 12 }}>
            <textarea
              value={noteInput} onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Internal note…"
              rows={2}
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical' }}
            />
            <button
              style={{ ...btnGhost, marginTop: 8 }} disabled={busy || !noteInput.trim()}
              onClick={() => run(async () => { await addNote(req.id, noteInput, { actorId: profile?.id }); setNoteInput(''); })}
            >
              Add note
            </button>
          </div>
        </div>
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Activity</div>
        {req.activity.length === 0 && <div style={{ fontSize: 13, color: '#94a3b8' }}>Nothing logged yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {req.activity.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <div style={{ width: 6, height: 6, borderRadius: 999, background: ACTIVITY_TONE[a.kind] || '#94a3b8', marginTop: 6, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ color: '#1e293b' }}>{a.body}</div>
                <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                  {new Date(a.created_at).toLocaleString('en-GB')}{a.author?.name ? ` · ${a.author.name}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
