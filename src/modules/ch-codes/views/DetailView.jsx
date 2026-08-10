import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Btn } from '../../../components/ui';
import { chipStyle, tones } from '../../../lib/tokens';
import { useAuth } from '../../../shell/AppShell';
import PersonEmail from '../components/PersonEmail';
import {
  getChCodeRequest, stageMeta, recordDecision, recordIdPoaReceived,
  recordCodeReceived, markInformDirect, markEnteredBm, submitRequest, rejectRequest,
  reopenRequest, advanceStage, setComms, addNote, recordClientReply, setPersonEmail,
} from '../api';

const font = "'Outfit', sans-serif";
const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const btnGhost = {
  padding: '8px 14px', fontSize: 13, fontWeight: 600, fontFamily: font,
  background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 10, cursor: 'pointer',
};
const isEmail = (e) => typeof e === 'string' && e.includes('@');
function localNowValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ACTIVITY_TONE = {
  email_out: '#0e7fe0', system: '#94a3b8', status_change: '#0f172a', client_reply: '#059669', note: '#64748b',
};

export default function DetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const actorId = profile?.id;
  const [req, setReq] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [callAt, setCallAt] = useState(localNowValue);
  const [noteInput, setNoteInput] = useState('');
  const [replyInput, setReplyInput] = useState('');

  const load = () => getChCodeRequest(id).then(setReq).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function decideWeDoIt() {
    let email = req.person?.email;
    if (!isEmail(email)) {
      const entered = window.prompt(`No email on file for ${req.person?.name || 'this director'}. Enter their email so the £20+VAT invoice can be sent:`, '');
      if (!entered || !entered.includes('@')) return;
      email = entered.trim();
      await setPersonEmail(req.person_id, email, { requestId: req.id, actorId });
    }
    if (!window.confirm(`Record “we do it”? This raises a £20 + VAT ID-check invoice and sends it to ${email} now.`)) return;
    await run(() => recordDecision({ ...req, person: { ...req.person, email } }, 'paid', { actorId }));
  }

  function reject() {
    const reason = window.prompt('Reject / exit — reason (optional):', '');
    if (reason === null) return;
    run(() => rejectRequest(req, reason, { actorId }));
  }

  if (error && !req) return <div style={{ padding: 24, color: tones.danger.fg }}>Failed to load: {error}</div>;
  if (!req) return <div style={{ padding: 24, color: '#64748b' }}>Loading…</div>;

  const meta = stageMeta(req.stage);
  const chasing = meta.chasing;
  const terminal = meta.terminal;

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 900 }}>
      <button onClick={() => navigate('/onboarding/ch-codes')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: font }}>
        <ArrowLeft size={14} /> Back to pipeline
      </button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          {/* The person's own client page (e.g. their sole-trader record),
              NOT the chase's anchor company — those can differ for a director
              we're chasing via a company they aren't personally the client for. */}
          <h1
            onClick={() => req.ownEntity?.id && navigate(`/clients/${req.ownEntity.id}`)}
            title={req.ownEntity?.id ? "Open this client's page" : undefined}
            style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a', cursor: req.ownEntity?.id ? 'pointer' : 'default', display: 'inline-block' }}
            onMouseEnter={(e) => { if (req.ownEntity?.id) e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {req.person?.name || 'Unknown'}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            {req.entity_id ? (
              <span onClick={() => navigate(`/clients/${req.entity_id}`)} title="Open this client's page"
                style={{ color: '#0e7fe0', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
                {req.entity?.name || 'client'}
              </span>
            ) : (req.entity?.name || '—')}
            {' · Owner: '}{req.owner?.name || 'unassigned'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ ...chipStyle(meta.tone), fontSize: 12 }}>{meta.short} · {meta.label}</span>
          {req.entity_id && (
            <button
              onClick={() => navigate(`/clients/${req.entity_id}`)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: font, fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 9, background: '#fff', color: '#0e7fe0', border: '1px solid #bfdbfe', cursor: 'pointer' }}
            >
              Open client page →
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ color: tones.danger.fg, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {!terminal && (
        <PersonEmail
          mode="banner" person={req.person} requestId={req.id} actorId={actorId} onSaved={load}
        />
      )}
      {req.escalation_status === 'call_needed' && (
        <div style={{ background: tones.danger.bg, color: tones.danger.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          📞 Call flagged for {req.person?.name}{req.called_at ? ` — logged ${new Date(req.called_at).toLocaleString('en-GB')}` : ''}.
        </div>
      )}
      {req.escalation_status === 'escalated_tracy' && (
        <div style={{ background: tones.danger.bg, color: tones.danger.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          🚨 Escalated — no response since the call flag.
        </div>
      )}
      {req.stage === 's5_entered' && req.bm_code_mismatch && (
        <div style={{ background: tones.danger.bg, color: tones.danger.fg, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
          ⚠️ BM shows a different personal code ({req.bm_code_mismatch}) — reconcile before submitting.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {req.stage === 's1_offer' && (
              <>
                <div style={{ fontSize: 13, color: '#64748b' }}>Queue the offer/reminders from the pipeline. When the client responds, record their decision.</div>
                <Btn onClick={() => run(() => advanceStage(req, 's2_decision', { actorId }))} disabled={busy}>Record decision →</Btn>
              </>
            )}
            {req.stage === 's2_decision' && (
              <>
                <Btn onClick={() => run(() => recordDecision(req, 'self', { actorId }))} disabled={busy}>Client is doing it (Stage 3a)</Btn>
                <button style={btnGhost} onClick={decideWeDoIt} disabled={busy}>We're doing it — £20+VAT invoice (Stage 3b)</button>
                <button style={btnGhost} onClick={() => run(() => advanceStage(req, 's1_offer', { actorId }))} disabled={busy}>← Back to Stage 1</button>
              </>
            )}
            {req.stage === 's3a_client' && (
              <Btn onClick={() => run(() => advanceStage(req, 's4_code', { actorId }))} disabled={busy}>Move to awaiting code (Stage 4)</Btn>
            )}
            {req.stage === 's3b_us' && (
              <>
                {req.billing_item_id && <div style={{ fontSize: 12.5, color: tones.accent.fg }}>£20+VAT ID-check invoice raised.</div>}
                <Btn onClick={() => run(() => recordIdPoaReceived(req, { actorId }))} disabled={busy}>ID &amp; POA received &amp; verified (Stage 4)</Btn>
              </>
            )}
            {req.stage === 's4_code' && (
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="FT5-15ED-7JY5"
                  style={{ flex: 1, padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8 }} />
                <button style={btnGhost} disabled={busy || !codeInput.trim()}
                  onClick={() => run(async () => { await recordCodeReceived(req, codeInput, { actorId }); setCodeInput(''); })}>Save code</button>
              </div>
            )}
            {req.stage === 's5_entered' && (
              <>
                <button style={{ ...btnGhost, ...(req.entered_inform_direct_at ? { background: tones.success.bg, borderColor: tones.success.border, color: tones.success.fg } : {}) }}
                  onClick={() => run(() => markInformDirect(req, !req.entered_inform_direct_at, { actorId }))} disabled={busy}>
                  {req.entered_inform_direct_at ? '✓ Entered on Inform Direct' : 'Mark entered on Inform Direct'}
                </button>
                <button style={{ ...btnGhost, ...(req.entered_bm_at ? { background: tones.success.bg, borderColor: tones.success.border, color: tones.success.fg } : {}) }}
                  onClick={() => run(() => markEnteredBm(req, !req.entered_bm_at, { actorId }))} disabled={busy}>
                  {req.entered_bm_at ? '✓ Entered on BM' : 'Mark entered on BM'}
                </button>
                <Btn onClick={() => run(() => submitRequest(req, { actorId }))} disabled={busy || !req.entered_inform_direct_at || !req.entered_bm_at}>
                  Mark submitted via Inform Direct (Stage 6)
                </Btn>
              </>
            )}
            {req.stage === 's6_submitted' && (
              <>
                <div style={{ fontSize: 13, color: tones.success.fg }}>✅ Filed{req.submitted_at ? ` on ${new Date(req.submitted_at).toLocaleDateString('en-GB')}` : ''}.</div>
                <button style={btnGhost} onClick={() => run(() => reopenRequest(req, { actorId }))} disabled={busy}>Reopen</button>
              </>
            )}
            {req.stage === 's7_rejected' && (
              <>
                <div style={{ fontSize: 13, color: tones.danger.fg }}>Rejected / exited{req.rejected_reason ? `: ${req.rejected_reason}` : ''}.</div>
                <button style={btnGhost} onClick={() => run(() => reopenRequest(req, { actorId }))} disabled={busy}>Reopen</button>
              </>
            )}

            {/* Comms ladder controls for chasing stages */}
            {chasing && (
              <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 6, paddingTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="datetime-local" value={callAt} onChange={(e) => setCallAt(e.target.value)}
                  style={{ padding: '6px 8px', fontSize: 12, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8 }} />
                <button style={btnGhost} disabled={busy || !callAt}
                  onClick={() => run(() => setComms(req, 'called', { actorId, calledAt: new Date(callAt).toISOString() }))}>Log call</button>
                {req.escalation_status !== 'escalated_tracy'
                  ? <button style={{ ...btnGhost, color: tones.danger.fg }} onClick={() => run(() => setComms(req, 'escalated', { actorId }))} disabled={busy}>Escalate</button>
                  : <button style={btnGhost} onClick={() => run(() => setComms(req, 'reset', { actorId }))} disabled={busy}>Clear flag</button>}
              </div>
            )}

            {!terminal && (
              <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 6, paddingTop: 10 }}>
                <button style={{ ...btnGhost, color: tones.danger.fg }} onClick={reject} disabled={busy}>Reject / exit</button>
              </div>
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Log a client reply / note</div>
          <textarea value={replyInput} onChange={(e) => setReplyInput(e.target.value)}
            placeholder="Paste or summarise what the client said in an email/call…" rows={3}
            style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button style={btnGhost} disabled={busy || !replyInput.trim()}
              onClick={() => run(async () => { await recordClientReply(req.id, replyInput, { actorId }); setReplyInput(''); })}>Log as client reply</button>
          </div>
          <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 12, paddingTop: 12 }}>
            <textarea value={noteInput} onChange={(e) => setNoteInput(e.target.value)} placeholder="Internal note…" rows={2}
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical' }} />
            <button style={{ ...btnGhost, marginTop: 8 }} disabled={busy || !noteInput.trim()}
              onClick={() => run(async () => { await addNote(req.id, noteInput, { actorId }); setNoteInput(''); })}>Add note</button>
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
