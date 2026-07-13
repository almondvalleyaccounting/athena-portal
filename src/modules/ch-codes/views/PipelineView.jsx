import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, PhoneCall, Mail, Send, IdCard, KeyRound, Check, Rows3, LayoutGrid,
  ArrowRight, Ban, RotateCcw, FileText, Building2, ChevronDown, ChevronRight,
} from 'lucide-react';
import { chipStyle, pillStyle, tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import { useAuth } from '../../../shell/AppShell';
import {
  listChCodeRequests, CH_STAGES, stageMeta, commsOf, COMMS_STEPS, daysSince,
  advanceStage, setComms, setEmailsSent, recordDecision, recordIdPoaReceived,
  recordCodeReceived, markInformDirect, markEnteredBm, submitRequest, rejectRequest,
  reopenRequest, setPersonEmail, queueEmail, queuedCountsByRequest,
} from '../api';

const font = "'Outfit', sans-serif";
const isEmail = (e) => typeof e === 'string' && e.includes('@');

function localNowValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CallLogModal({ request, onConfirm, onCancel, busy }) {
  const [dt, setDt] = useState(localNowValue);
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: font }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 360, maxWidth: '92vw', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <PhoneCall size={16} color={tones.accent.solid} />
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Log a call</div>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>When did you call {request.person?.name || 'this person'}?</p>
        <input autoFocus type="datetime-local" value={dt} onChange={(e) => setDt(e.target.value)}
          style={{ width: '100%', padding: '9px 11px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} disabled={busy} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, fontFamily: font, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 9, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => dt && onConfirm(new Date(dt).toISOString())} disabled={!dt || busy}
            style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, fontFamily: font, background: (!dt || busy) ? '#e5e7eb' : tones.accent.solid, color: (!dt || busy) ? '#94a3b8' : '#fff', border: 'none', borderRadius: 9, cursor: (!dt || busy) ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Saving…' : 'Log call'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmailCounter({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => { setDraft(String(value ?? 0)); }, [value]);
  if (editing) {
    return (
      <input autoFocus type="number" min={0} value={draft}
        onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
        onBlur={() => { setEditing(false); if (String(value ?? 0) !== draft) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(String(value ?? 0)); setEditing(false); } }}
        style={{ width: 52, padding: '3px 6px', fontSize: 12, fontFamily: font, border: '1px solid #93c5fd', borderRadius: 7 }} />
    );
  }
  return (
    <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Emails sent this stage — click to set"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 999, padding: '3px 9px', fontSize: 12, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: font }}>
      <Mail size={12} /> {value ?? 0}/3
    </button>
  );
}

// Read-only chip showing where the current stage's chase ladder is up to.
function CommsChip({ r }) {
  const c = commsOf(r);
  const meta = COMMS_STEPS.find((s) => s.value === c) || COMMS_STEPS[0];
  if (c === 'called' && r.called_at) {
    return <span style={{ ...chipStyle('accent'), display: 'inline-flex', alignItems: 'center', gap: 3 }} title={`Called ${new Date(r.called_at).toLocaleString('en-GB')}`}><PhoneCall size={10} /> Called {new Date(r.called_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>;
  }
  if (c === 'escalated') return <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 3 }}><AlertTriangle size={10} /> Escalated</span>;
  return <span style={chipStyle(meta.tone)}>{meta.label}</span>;
}

function Btn({ icon: Icon, label, onClick, disabled, tone = 'info', solid = false }) {
  const t = tones[tone] || tones.info;
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: font, fontSize: 12, fontWeight: 600,
        padding: '5px 10px', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
        background: solid ? (disabled ? '#e5e7eb' : t.solid) : '#fff',
        color: solid ? '#fff' : (disabled ? '#cbd5e1' : t.fg),
        border: `1px solid ${disabled ? '#eef2f6' : (solid ? t.solid : t.border)}`,
      }}>
      {Icon && <Icon size={13} />} {label}
    </button>
  );
}

const QUEUE_BUTTONS = {
  s1_offer: [['offer', 'Queue offer', Send, 'info'], ['reminder', 'Remind: decision', Mail, 'warning']],
  s3a_client: [['self_verify', 'Remind: self-verify', Mail, 'info']],
  s3b_us: [['id_poa', 'Remind: ID & POA', IdCard, 'accent']],
  s4_code: [['code', 'Remind: code', KeyRound, 'success']],
};

export default function PipelineView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const actorId = profile?.id;
  const [rows, setRows] = useState(null);
  const [queuedCounts, setQueuedCounts] = useState({});
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [filter, setFilter] = useState('open'); // open | submitted | all
  const [search, setSearch] = useState('');
  const [compact, setCompact] = useState(true);
  const [callFor, setCallFor] = useState(null);
  const [codeDraft, setCodeDraft] = useState({}); // requestId -> code input
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ch_collapsed_stages') || '[]')); }
    catch { return new Set(); }
  });

  const persistCollapsed = (next) => {
    setCollapsed(next);
    try { localStorage.setItem('ch_collapsed_stages', JSON.stringify([...next])); } catch { /* ignore */ }
  };
  const toggleStage = (value) => {
    const next = new Set(collapsed);
    next.has(value) ? next.delete(value) : next.add(value);
    persistCollapsed(next);
  };
  const setAllCollapsed = (all) => persistCollapsed(all ? new Set(CH_STAGES.map((g) => g.value)) : new Set());

  const load = () => Promise.all([listChCodeRequests(), queuedCountsByRequest()])
    .then(([data, counts]) => { setRows(data); setQueuedCounts(counts); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const totalQueued = useMemo(() => Object.values(queuedCounts).reduce((a, b) => a + b, 0), [queuedCounts]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (filter === 'open' && ['s6_submitted', 's7_rejected'].includes(r.stage)) return false;
      if (filter === 'submitted' && r.stage !== 's6_submitted') return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.person?.name?.toLowerCase().includes(q) && !r.entity?.name?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  const grouped = useMemo(() => {
    const m = {};
    for (const r of filtered) (m[r.stage] ||= []).push(r);
    return m;
  }, [filtered]);

  const kpis = useMemo(() => {
    if (!rows) return { call: 0, esc: 0 };
    const open = rows.filter((r) => !['s6_submitted', 's7_rejected'].includes(r.stage));
    return {
      call: open.filter((r) => r.escalation_status === 'call_needed').length,
      esc: open.filter((r) => r.escalation_status === 'escalated_tracy').length,
    };
  }, [rows]);

  async function act(id, fn, msg) {
    setBusyId(id); setError(null); setFlash(null);
    try { await fn(); await load(); if (msg) setFlash(msg); }
    catch (e) { setError(e.message); }
    setBusyId(null);
  }

  // Stage 3b guard: make sure we hold a client email before raising/sending the invoice.
  async function decideWeDoIt(r) {
    let email = r.person?.email;
    if (!isEmail(email)) {
      const entered = window.prompt(`No email on file for ${r.person?.name || 'this director'}. Enter their email so the £20+VAT invoice can be sent:`, '');
      if (!entered || !entered.includes('@')) return;
      email = entered.trim();
      await setPersonEmail(r.person_id, email);
    }
    if (!window.confirm(`Record “we do it” for ${r.person?.name || 'this director'}?\n\nThis raises a £20 + VAT ID-check invoice and sends it to ${email} now, and moves them to Stage 3b.`)) return;
    await act(r.id, () => recordDecision({ ...r, person: { ...r.person, email } }, 'paid', { actorId }), `Decision recorded — invoice sent to ${email}.`);
  }

  function reject(r) {
    const reason = window.prompt('Reject / exit — reason (optional). This removes them from the active pipeline:', '');
    if (reason === null) return;
    act(r.id, () => rejectRequest(r, reason, { actorId }), `${r.person?.name || 'Request'} moved to Rejected / exit.`);
  }

  // The stage-specific action row (used in both densities).
  function StageControls({ r }) {
    const busy = busyId === r.id;
    const stage = r.stage;
    const qbtns = QUEUE_BUTTONS[stage] || [];
    const chasing = stageMeta(stage).chasing;

    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Queue emails for this stage */}
        {qbtns.map(([kind, label, Icon, tone]) => (
          <Btn key={kind} icon={Icon} label={label} tone={tone} disabled={busy}
            onClick={() => act(r.id, () => queueEmail(r, kind, { actorId }), `${label} queued for ${r.person?.name || 'client'}.`)} />
        ))}

        {/* Comms ladder: call + escalate for chasing stages */}
        {chasing && (
          <>
            <Btn icon={PhoneCall} label="Log call" tone="accent" disabled={busy} onClick={() => setCallFor(r)} />
            {r.escalation_status !== 'escalated_tracy'
              ? <Btn icon={AlertTriangle} label="Escalate" tone="danger" disabled={busy} onClick={() => act(r.id, () => setComms(r, 'escalated', { actorId }))} />
              : <Btn icon={RotateCcw} label="Clear flag" tone="neutral" disabled={busy} onClick={() => act(r.id, () => setComms(r, 'reset', { actorId }))} />}
          </>
        )}

        {/* Stage-specific advance controls */}
        {stage === 's1_offer' && (
          <Btn icon={ArrowRight} label="Record decision" tone="info" solid disabled={busy} onClick={() => act(r.id, () => advanceStage(r, 's2_decision', { actorId }))} />
        )}
        {stage === 's2_decision' && (
          <>
            <Btn icon={Check} label="Client is doing it" tone="info" solid disabled={busy} onClick={() => act(r.id, () => recordDecision(r, 'self', { actorId }), `${r.person?.name || 'Client'} → self-verifying (Stage 3a).`)} />
            <Btn icon={FileText} label="We're doing it (£20+VAT)" tone="accent" solid disabled={busy} onClick={() => decideWeDoIt(r)} />
            <Btn icon={RotateCcw} label="Back to Stage 1" tone="neutral" disabled={busy} onClick={() => act(r.id, () => advanceStage(r, 's1_offer', { actorId }))} />
          </>
        )}
        {stage === 's3a_client' && (
          <Btn icon={ArrowRight} label="Move to awaiting code" tone="warning" solid disabled={busy} onClick={() => act(r.id, () => advanceStage(r, 's4_code', { actorId }), `${r.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's3b_us' && (
          <Btn icon={ArrowRight} label="ID & POA received" tone="warning" solid disabled={busy} onClick={() => act(r.id, () => recordIdPoaReceived(r, { actorId }), `${r.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's4_code' && (
          <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <input value={codeDraft[r.id] || ''} onChange={(e) => setCodeDraft((d) => ({ ...d, [r.id]: e.target.value }))}
              placeholder="FT5-15ED-7JY5"
              style={{ padding: '5px 9px', fontSize: 12, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, width: 130 }} />
            <Btn icon={Check} label="Save code" tone="success" solid disabled={busy || !(codeDraft[r.id] || '').trim()}
              onClick={() => act(r.id, async () => { await recordCodeReceived(r, codeDraft[r.id], { actorId }); setCodeDraft((d) => ({ ...d, [r.id]: '' })); }, `Code saved for ${r.person?.name || 'client'} (Stage 5).`)} />
          </span>
        )}
        {stage === 's5_entered' && (
          <>
            <Btn icon={Building2} label={r.entered_inform_direct_at ? 'Inform Direct ✓' : 'Inform Direct'} tone="info" solid={!!r.entered_inform_direct_at} disabled={busy}
              onClick={() => act(r.id, () => markInformDirect(r, !r.entered_inform_direct_at, { actorId }))} />
            <Btn icon={Building2} label={r.entered_bm_at ? 'BM ✓' : 'BM'} tone="info" solid={!!r.entered_bm_at} disabled={busy}
              onClick={() => act(r.id, () => markEnteredBm(r, !r.entered_bm_at, { actorId }))} />
            <Btn icon={Check} label="Mark submitted" tone="success" solid
              disabled={busy || !r.entered_inform_direct_at || !r.entered_bm_at}
              onClick={() => act(r.id, () => submitRequest(r, { actorId }), `${r.person?.name || 'Request'} filed (Stage 6).`)} />
          </>
        )}
        {stage === 's6_submitted' && (
          <>
            <span style={{ fontSize: 12, color: tones.success.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Check size={13} /> Filed{r.submitted_at ? ` ${new Date(r.submitted_at).toLocaleDateString('en-GB')}` : ''}
            </span>
            <Btn icon={RotateCcw} label="Reopen" tone="neutral" disabled={busy} onClick={() => act(r.id, () => reopenRequest(r, { actorId }))} />
          </>
        )}
        {stage === 's7_rejected' && (
          <>
            <span style={{ fontSize: 12, color: tones.danger.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Ban size={12} /> {r.rejected_reason || 'Rejected / exited'}
            </span>
            <Btn icon={RotateCcw} label="Reopen" tone="neutral" disabled={busy} onClick={() => act(r.id, () => reopenRequest(r, { actorId }))} />
          </>
        )}

        {/* Reject / exit — available from any live stage */}
        {!stageMeta(stage).terminal && (
          <Btn icon={Ban} label="Reject / exit" tone="danger" disabled={busy} onClick={() => reject(r)} />
        )}
      </div>
    );
  }

  function Tile({ r }) {
    const busy = busyId === r.id;
    const queued = queuedCounts[r.id] || 0;
    const chasing = stageMeta(r.stage).chasing;
    const age = daysSince(r.requested_at);

    const badges = (
      <>
        {queued > 0 && <span style={chipStyle('info')}>{queued} queued</span>}
        {chasing && <CommsChip r={r} />}
        {r.stage === 's3b_us' && r.billing_item_id && <span style={chipStyle('accent')}>£20+VAT invoiced</span>}
        {r.stage === 's5_entered' && r.bm_code_mismatch && <span style={chipStyle('danger')}>BM mismatch</span>}
        {!isEmail(r.person?.email) && !stageMeta(r.stage).terminal && <span style={chipStyle('warning')}>no email</span>}
      </>
    );

    if (compact) {
      return (
        <div onClick={() => navigate(`/onboarding/ch-codes/${r.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 14px', cursor: 'pointer', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 150, flex: '1 1 150px' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{r.person?.name || '—'}</span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}> · {r.entity?.name || '—'}</span>
          </div>
          {badges}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {chasing && <EmailCounter value={r.emails_sent} onSave={(v) => act(r.id, () => setEmailsSent(r.id, v))} />}
            <StageControls r={r} />
          </div>
        </div>
      );
    }

    return (
      <div onClick={() => navigate(`/onboarding/ch-codes/${r.id}`)}
        style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 180 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{r.person?.name || '—'}</div>
            <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 2 }}>{r.entity?.name || '—'}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{badges}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          {chasing && <EmailCounter value={r.emails_sent} onSave={(v) => act(r.id, () => setEmailsSent(r.id, v))} />}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
            {age != null ? `${age}d in stage` : ''}
          </span>
        </div>
        <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 12, paddingTop: 12 }}>
          <StageControls r={r} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Companies House personal codes</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Every director &amp; PSC by stage — from the first offer through to the Confirmation Statement filing
          </p>
        </div>
        <ChSubNav active="Pipeline" queuedCount={totalQueued} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {kpis.call > 0 && <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}><PhoneCall size={11} /> {kpis.call} need a call</span>}
        {kpis.esc > 0 && <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}><AlertTriangle size={11} /> {kpis.esc} escalated</span>}
        {totalQueued > 0 && (
          <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, border: 'none', cursor: 'pointer' }}>
            <Send size={11} /> {totalQueued} email{totalQueued === 1 ? '' : 's'} queued — review &amp; send
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['submitted', 'Submitted'], ['all', 'All']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} style={pillStyle({ tone: 'info', active: filter === v })}>{label}</button>
        ))}
        <button onClick={() => setCompact((c) => !c)} title={compact ? 'Switch to comfortable tiles' : 'Switch to compact rows'}
          style={{ ...pillStyle({ tone: 'neutral', active: compact }), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {compact ? <LayoutGrid size={13} /> : <Rows3 size={13} />} {compact ? 'Comfortable' : 'Compact'}
        </button>
        <button onClick={() => setAllCollapsed(collapsed.size < CH_STAGES.length)} title="Collapse or expand all stages"
          style={{ ...pillStyle({ tone: 'neutral', active: false }), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {collapsed.size < CH_STAGES.length ? <><ChevronRight size={13} /> Collapse all</> : <><ChevronDown size={13} /> Expand all</>}
        </button>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search person or company…"
          style={{ marginLeft: 'auto', padding: '7px 12px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff' }} />
      </div>

      {flash && (
        <div style={{ background: tones.success.bg, color: tones.success.fg, borderRadius: 10, padding: '9px 14px', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Check size={14} /> {flash}
          {totalQueued > 0 && <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: tones.success.fg, fontWeight: 700, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', fontFamily: font }}>Go to queue →</button>}
        </div>
      )}
      {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>Failed: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{ background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
          Nothing here.
        </div>
      )}

      {rows && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {CH_STAGES.map((g) => {
            const groupRows = grouped[g.value] || [];
            const showEmpty = !g.terminal && filter !== 'submitted';
            if (groupRows.length === 0 && !showEmpty) return null;
            const t = tones[g.tone] || tones.neutral;
            const isCollapsed = collapsed.has(g.value);
            return (
              <div key={g.value}>
                <button
                  onClick={() => toggleStage(g.value)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: font, width: '100%', textAlign: 'left' }}
                >
                  {isCollapsed ? <ChevronRight size={15} color="#94a3b8" /> : <ChevronDown size={15} color="#94a3b8" />}
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: t.solid, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4 }}>{g.short}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{g.label}</span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{groupRows.length}</span>
                </button>
                {!isCollapsed && (groupRows.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', padding: '2px 2px 12px' }}>Nobody at this stage.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 12 }}>
                    {groupRows.map((r) => <Tile key={r.id} r={r} />)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {callFor && (
        <CallLogModal request={callFor} busy={busyId === callFor.id}
          onCancel={() => setCallFor(null)}
          onConfirm={async (iso) => { const r = callFor; setCallFor(null); await act(r.id, () => setComms(r, 'called', { actorId, calledAt: iso }), `Call logged for ${r.person?.name || 'client'}.`); }} />
      )}
    </div>
  );
}
