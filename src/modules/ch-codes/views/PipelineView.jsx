import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, PhoneCall, Mail, Send, IdCard, KeyRound, Check, Rows3, LayoutGrid,
  ArrowRight, Ban, RotateCcw, FileText, Building2, ChevronDown, ChevronRight,
} from 'lucide-react';
import { chipStyle, pillStyle, tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import PersonEmail from '../components/PersonEmail';
import { useAuth } from '../../../shell/AppShell';
import {
  listChCodeRequests, CH_STAGES, stageMeta, commsOf, daysSince,
  CALL_OUTCOMES, callOutcomeMeta, isEscalated, clearEscalation,
  advanceStage, setComms, setEmailsSent, recordDecision, recordIdPoaReceived,
  recordCodeReceived, markInformDirect, markEnteredBm, submitRequest, rejectRequest,
  reopenRequest, setPersonEmail, queueEmail, queuedCountsByRequest, queuedKindsByRequest,
} from '../api';

const font = "'Outfit', sans-serif";
const isEmail = (e) => typeof e === 'string' && e.includes('@');

// Stages 1–4 verify the PERSON's identity — that's a one-time thing
// regardless of how many companies they direct, so a director chased on
// two companies at once should show as ONE tile, not two. From Stage 5
// on, the work (Inform Direct/BM entry, Confirmation Statement) is
// genuinely per company, so those stay split.
const PERSON_LEVEL_STAGES = new Set(['s1_offer', 's2_decision', 's3a_client', 's3b_us', 's4_code']);

// Split a person's name into surname/forename for sorting. Handles both
// "First Middle Last" and BM's "Last, First" formats.
function nameParts(r) {
  const raw = (r.person?.name || '').trim();
  if (raw.includes(',')) {
    const [sur, fore] = raw.split(',');
    return { surname: (sur || '').trim().toLowerCase(), forename: (fore || '').trim().split(/\s+/)[0]?.toLowerCase() || '' };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  return {
    forename: (parts[0] || '').toLowerCase(),
    surname: (parts.length > 1 ? parts[parts.length - 1] : parts[0] || '').toLowerCase(),
  };
}
// The row within a group with the most chasing progress — used to represent
// the whole group (comms ladder, email counter) with a single value.
function repRow(group) {
  return group.rows.reduce((best, r) => ((r.emails_sent || 0) > (best.emails_sent || 0) ? r : best), group.rows[0]);
}
// Emails sent (desc) → surname → forename, across tile groups.
function cmpGroups(a, b) {
  const d = (repRow(b).emails_sent || 0) - (repRow(a).emails_sent || 0);
  if (d) return d;
  const na = nameParts(a.rows[0]), nb = nameParts(b.rows[0]);
  return na.surname.localeCompare(nb.surname) || na.forename.localeCompare(nb.forename);
}

function localNowValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fieldStyle = { width: '100%', padding: '9px 11px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' };
const fieldLabel = { display: 'block', fontSize: 11.5, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, margin: '12px 0 5px' };

function CallLogModal({ group, onConfirm, onCancel, busy }) {
  const [dt, setDt] = useState(localNowValue);
  const [outcome, setOutcome] = useState(CALL_OUTCOMES[0].value);
  const [note, setNote] = useState('');
  const name = group.rows[0].person?.name || 'this person';
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: font }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 400, maxWidth: '92vw', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <PhoneCall size={16} color={tones.accent.solid} />
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Log a call</div>
        </div>
        <p style={{ margin: '0 0 2px', fontSize: 13, color: '#64748b' }}>When did you call {name}, and what happened?</p>

        <label style={fieldLabel}>When</label>
        <input autoFocus type="datetime-local" value={dt} onChange={(e) => setDt(e.target.value)} style={fieldStyle} />

        <label style={fieldLabel}>What happened</label>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={fieldStyle}>
          {CALL_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <label style={fieldLabel}>Note <span style={{ textTransform: 'none', fontWeight: 500, letterSpacing: 0 }}>(optional)</span></label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Anything else worth knowing next time we pick this up…"
          style={{ ...fieldStyle, resize: 'vertical' }} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onCancel} disabled={busy} style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, fontFamily: font, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 9, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => dt && onConfirm({ calledAt: new Date(dt).toISOString(), outcome, note })} disabled={!dt || busy}
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
  // Colour the counter by how many emails have gone: 0 grey, 1 blue, 2 amber, 3+ red.
  const n = value ?? 0;
  const t = n >= 3 ? tones.danger : n === 2 ? tones.warning : n === 1 ? tones.info : { bg: '#f8fafc', border: '#e5e7eb', fg: '#475569' };
  return (
    <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Emails sent this stage — click to set"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 999, padding: '3px 9px', fontSize: 12, fontWeight: 700, color: t.fg, cursor: 'pointer', fontFamily: font }}>
      <Mail size={12} /> {n}/3
    </button>
  );
}

// Chips for the escalation/call/reply states — the coloured email counter
// already conveys the 0/1/2/3 email progress, so we don't duplicate it here.
// These stack rather than override each other: an escalated request that has
// since been called shows both, because the escalation doesn't go away.
function CommsChip({ r }) {
  const chips = [];
  // Reply hold comes first — they answered; process it before chasing.
  if (r.client_replied_at) {
    chips.push(
      <span key="replied" style={{ ...chipStyle('success'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
        title={`Email reply received ${new Date(r.client_replied_at).toLocaleString('en-GB')} — reminders held until the stage moves`}>
        📩 Replied</span>,
    );
  }
  if (isEscalated(r)) {
    chips.push(
      <span key="esc" style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 3 }}
        title="Escalated — stays on the record until someone removes it deliberately">
        <AlertTriangle size={10} /> Escalated</span>,
    );
  }
  if (r.called_at || r.escalation_status === 'call_needed') {
    const oc = callOutcomeMeta(r.last_call_outcome);
    const when = r.called_at ? new Date(r.called_at) : null;
    const title = [
      when ? `Called ${when.toLocaleString('en-GB')}` : 'Call needed',
      oc ? `— ${oc.label}` : null,
      r.last_call_note || null,
    ].filter(Boolean).join(' ');
    chips.push(
      <span key="call" style={{ ...chipStyle(oc?.tone || 'accent'), display: 'inline-flex', alignItems: 'center', gap: 3 }} title={title}>
        <PhoneCall size={10} />
        {when ? `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${oc && oc.value !== 'other' ? ` · ${oc.label}` : ''}` : 'Call needed'}
      </span>,
    );
  }
  return chips.length ? <>{chips}</> : null;
}

function Btn({ icon: Icon, label, onClick, disabled, tone = 'info', solid = false, title }) {
  const t = tones[tone] || tones.info;
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={disabled} title={title}
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
  const [queuedKinds, setQueuedKinds] = useState({});
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

  const load = () => Promise.all([listChCodeRequests(), queuedCountsByRequest(), queuedKindsByRequest()])
    .then(([data, counts, kinds]) => { setRows(data); setQueuedCounts(counts); setQueuedKinds(kinds); })
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

  // Group into tiles: one per person for the identity-verification stages
  // (a director chased on N companies at once is still one conversation),
  // one per request everywhere else (Entered/Submitted/Rejected are
  // genuinely per-company work).
  const grouped = useMemo(() => {
    const byStage = {};
    for (const r of filtered) (byStage[r.stage] ||= []).push(r);
    const out = {};
    for (const stage of Object.keys(byStage)) {
      const rowsInStage = byStage[stage];
      if (PERSON_LEVEL_STAGES.has(stage)) {
        const byPerson = new Map();
        for (const r of rowsInStage) {
          const key = r.person_id || r.id;
          if (!byPerson.has(key)) byPerson.set(key, { key: `p:${key}`, rows: [] });
          byPerson.get(key).rows.push(r);
        }
        out[stage] = [...byPerson.values()];
      } else {
        out[stage] = rowsInStage.map((r) => ({ key: r.id, rows: [r] }));
      }
      out[stage].sort(cmpGroups);
    }
    return out;
  }, [filtered]);

  // Chase-ladder summary across the open chasing stages (s1/s3a/s3b/s4) —
  // counts PEOPLE, not requests, so a multi-company director isn't double-counted.
  const summary = useMemo(() => {
    const s = { not_started: 0, one_email: 0, two_emails: 0, three_emails: 0, called: 0, escalated: 0, total: 0 };
    const byPerson = new Map();
    for (const r of rows || []) {
      if (!stageMeta(r.stage).chasing) continue;
      const key = r.person_id || r.id;
      const existing = byPerson.get(key);
      if (!existing || (r.emails_sent || 0) > (existing.emails_sent || 0)) byPerson.set(key, r);
    }
    for (const r of byPerson.values()) {
      s[commsOf(r)] += 1;
      s.total += 1;
    }
    return s;
  }, [rows]);

  // Fan an action out across every request in a tile group (person-level
  // groups can hold more than one company's request) and reload once done.
  async function actGroup(group, fn, msg) {
    setBusyId(group.key); setError(null); setFlash(null);
    try { await Promise.all(group.rows.map((row) => fn(row))); await load(); if (msg) setFlash(msg); }
    catch (e) { setError(e.message); }
    setBusyId(null);
  }

  // Nothing can be sent without an address. Where we don't hold one, ask for it
  // right here and save it against the person — otherwise Sophie has to go off
  // to the people record and lose her place in the pipeline. Returns null if
  // she cancels or types something that isn't an email.
  async function ensureEmail(row, why) {
    if (isEmail(row.person?.email)) return String(row.person.email).split(/[;,]/)[0].trim();
    const entered = window.prompt(`No email on file for ${row.person?.name || 'this director'}. Enter their email ${why}:`, '');
    if (entered === null) return null;
    const clean = entered.trim();
    if (!clean.includes('@')) { setError('That doesn’t look like an email address — nothing saved.'); return null; }
    await setPersonEmail(row.person_id, clean, { requestId: row.id, actorId });
    return clean;
  }

  // Queue one chaser for the person. Deliberately NOT via actGroup: a group can
  // hold several companies, and one email covers the lot — fanning out would
  // drop the same email on the queue once per company.
  async function queueFor(group, first, kind, label) {
    setBusyId(group.key); setError(null); setFlash(null);
    try {
      const email = await ensureEmail(first, `so the ${label.toLowerCase()} can be sent`);
      if (email) {
        await queueEmail({ ...first, person: { ...first.person, email } }, kind, { actorId });
        await load();
        setFlash(`${label} queued for ${first.person?.name || 'client'}.`);
      }
    } catch (e) { setError(e.message); }
    setBusyId(null);
  }

  // Stage 3b guard: make sure we hold a client email before raising/sending the invoice.
  // Raises one £20+VAT invoice per company in the group (billing is inherently
  // per-client, so a director of two companies is invoiced on each).
  async function decideWeDoIt(group) {
    const rep = group.rows[0];
    let email;
    try { email = await ensureEmail(rep, 'so the £20+VAT invoice can be sent'); }
    catch (e) { setError(e.message); return; }
    if (!email) return;
    const companies = group.rows.map((r) => r.entity?.name).filter(Boolean).join(', ');
    if (!window.confirm(`Record “we do it” for ${rep.person?.name || 'this director'}?\n\nThis raises a £20 + VAT ID-check invoice for each company (${companies}) and sends it to ${email} now, and moves them to Stage 3b.`)) return;
    await actGroup(group, (row) => recordDecision({ ...row, person: { ...row.person, email } }, 'paid', { actorId }), `Decision recorded — invoice sent to ${email}.`);
  }

  function reject(group) {
    const reason = window.prompt('Reject / exit — reason (optional). This removes them from the active pipeline:', '');
    if (reason === null) return;
    actGroup(group, (row) => rejectRequest(row, reason, { actorId }), `${group.rows[0].person?.name || 'Request'} moved to Rejected / exit.`);
  }

  // The stage-specific action row (used in both densities). Operates on a
  // tile group — for person-level stages this may fan out across >1 company.
  function StageControls({ group }) {
    const rep = repRow(group);
    const busy = busyId === group.key;
    const stage = rep.stage;
    const qbtns = QUEUE_BUTTONS[stage] || [];
    const chasing = stageMeta(stage).chasing;
    const emailsSent = rep.emails_sent || 0;
    const first = group.rows[0];

    // Grey out queue buttons the chase ladder has moved past:
    //  - offer: the first email IS the offer, so once anything has gone
    //    (emails_sent >= 1) the offer has been made — next is a reminder.
    //  - reminders: policy is offer + 2 reminders = 3 emails, then a call.
    //    At 3 emails the reminder is greyed — the next action is a call
    //    (surfaced on the Wednesday call list to Sophie).
    const queueDisabled = (kind) => kind === 'offer' ? emailsSent >= 1 : emailsSent >= 3;
    const queueTitle = (kind, disabled) => !disabled ? undefined
      : kind === 'offer'
        ? 'Offer already sent — the offer is the first email'
        : '3 emails sent — a call is now required (see the Wednesday call list)';

    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Queue emails for this stage — one email covers every company in
            the group, so this always targets the first request only. */}
        {qbtns.map(([kind, label, Icon, tone]) => {
          if ((queuedKinds[first.id] || {})[kind]) {
            return <Btn key={kind} icon={Check} label="Queued" tone="success" disabled
              title="This email is already in the send queue — review it under Queue" />;
          }
          const qd = queueDisabled(kind);
          return (
            <Btn key={kind} icon={Icon} label={label} tone={tone} disabled={busy || qd} title={queueTitle(kind, qd)}
              onClick={() => queueFor(group, first, kind, label)} />
          );
        })}

        {/* Comms ladder: call + escalate for chasing stages — applies to every company at once */}
        {chasing && (
          <>
            <Btn icon={PhoneCall} label="Log call" tone="accent" disabled={busy} onClick={() => setCallFor(group)} />
            {!isEscalated(rep) && (
              <Btn icon={AlertTriangle} label="Escalate" tone="danger" disabled={busy}
                title="Escalate to Tracy. This stays on the record — logging a call or moving stage won't clear it."
                onClick={() => actGroup(group, (row) => setComms(row, 'escalated', { actorId }))} />
            )}
            {(rep.called_at || rep.escalation_status === 'call_needed') && (
              <Btn icon={RotateCcw} label="Clear call flag" tone="neutral" disabled={busy}
                title={isEscalated(rep) ? 'Clears the call only — the escalation stays' : 'Clears the call flag'}
                onClick={() => actGroup(group, (row) => setComms(row, 'reset', { actorId }))} />
            )}
            {isEscalated(rep) && (
              <Btn icon={Ban} label="Remove escalation" tone="neutral" disabled={busy}
                title="Escalation is meant to be permanent — only use this if it was applied by mistake."
                onClick={() => {
                  if (!window.confirm(`Remove the escalation on ${first.person?.name || 'this request'}?

Escalation is meant to be permanent — only do this if it was applied by mistake.`)) return;
                  actGroup(group, (row) => clearEscalation(row, { actorId }), 'Escalation removed.');
                }} />
            )}
          </>
        )}

        {/* Stage-specific advance controls */}
        {stage === 's1_offer' && (
          <Btn icon={ArrowRight} label="Record decision" tone="info" solid disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's2_decision', { actorId }))} />
        )}
        {stage === 's2_decision' && (
          <>
            <Btn icon={Check} label="Client is doing it" tone="info" solid disabled={busy} onClick={() => actGroup(group, (row) => recordDecision(row, 'self', { actorId }), `${first.person?.name || 'Client'} → self-verifying (Stage 3a).`)} />
            <Btn icon={FileText} label="We're doing it (£20+VAT)" tone="accent" solid disabled={busy} onClick={() => decideWeDoIt(group)} />
            <Btn icon={RotateCcw} label="Back to Stage 1" tone="neutral" disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's1_offer', { actorId }))} />
          </>
        )}
        {stage === 's3a_client' && (
          <Btn icon={ArrowRight} label="Move to awaiting code" tone="warning" solid disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's4_code', { actorId }), `${first.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's3b_us' && (
          <Btn icon={ArrowRight} label="ID & POA received" tone="warning" solid disabled={busy} onClick={() => actGroup(group, (row) => recordIdPoaReceived(row, { actorId }), `${first.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's4_code' && (
          <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <input value={codeDraft[group.key] || ''} onChange={(e) => setCodeDraft((d) => ({ ...d, [group.key]: e.target.value }))}
              placeholder="FT5-15ED-7JY5"
              style={{ padding: '5px 9px', fontSize: 12, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, width: 130 }} />
            <Btn icon={Check} label="Save code" tone="success" solid disabled={busy || !(codeDraft[group.key] || '').trim()}
              onClick={() => actGroup(group, (row) => recordCodeReceived(row, codeDraft[group.key], { actorId }), `Code saved for ${first.person?.name || 'client'} (Stage 5).`).then(() => setCodeDraft((d) => ({ ...d, [group.key]: '' })))} />
          </span>
        )}
        {stage === 's5_entered' && (
          <>
            <Btn icon={Building2} label={rep.entered_inform_direct_at ? 'Inform Direct ✓' : 'Inform Direct'} tone="info" solid={!!rep.entered_inform_direct_at} disabled={busy}
              onClick={() => actGroup(group, (row) => markInformDirect(row, !row.entered_inform_direct_at, { actorId }))} />
            <Btn icon={Building2} label={rep.entered_bm_at ? 'BM ✓' : 'BM'} tone="info" solid={!!rep.entered_bm_at} disabled={busy}
              onClick={() => actGroup(group, (row) => markEnteredBm(row, !row.entered_bm_at, { actorId }))} />
            <Btn icon={Check} label="Mark submitted" tone="success" solid
              disabled={busy || !rep.entered_inform_direct_at || !rep.entered_bm_at}
              onClick={() => actGroup(group, (row) => submitRequest(row, { actorId }), `${first.person?.name || 'Request'} filed (Stage 6).`)} />
          </>
        )}
        {stage === 's6_submitted' && (
          <>
            <span style={{ fontSize: 12, color: tones.success.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Check size={13} /> Filed{rep.submitted_at ? ` ${new Date(rep.submitted_at).toLocaleDateString('en-GB')}` : ''}
            </span>
            <Btn icon={RotateCcw} label="Reopen" tone="neutral" disabled={busy} onClick={() => actGroup(group, (row) => reopenRequest(row, { actorId }))} />
          </>
        )}
        {stage === 's7_rejected' && (
          <>
            <span style={{ fontSize: 12, color: tones.danger.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Ban size={12} /> {rep.rejected_reason || 'Rejected / exited'}
            </span>
            <Btn icon={RotateCcw} label="Reopen" tone="neutral" disabled={busy} onClick={() => actGroup(group, (row) => reopenRequest(row, { actorId }))} />
          </>
        )}

        {/* Reject / exit — available from any live stage */}
        {!stageMeta(stage).terminal && (
          <Btn icon={Ban} label="Reject / exit" tone="danger" disabled={busy} onClick={() => reject(group)} />
        )}
      </div>
    );
  }

  function Tile({ group }) {
    const rep = repRow(group);
    const first = group.rows[0];
    const busy = busyId === group.key;
    const queued = group.rows.reduce((sum, row) => sum + (queuedCounts[row.id] || 0), 0);
    const chasing = stageMeta(rep.stage).chasing;
    const age = daysSince(rep.requested_at);
    const entityLabel = group.rows.map((r) => r.entity?.name).filter(Boolean).join(', ') || '—';

    const badges = (
      <>
        {queued > 0 && <span style={chipStyle('info')}>{queued} queued</span>}
        {chasing && <CommsChip r={rep} />}
        {rep.stage === 's3b_us' && group.rows.some((r) => r.billing_item_id) && <span style={chipStyle('accent')}>£20+VAT invoiced</span>}
        {rep.stage === 's5_entered' && rep.bm_code_mismatch && <span style={chipStyle('danger')}>BM mismatch</span>}
        {!stageMeta(rep.stage).terminal && (
          <PersonEmail person={first.person} requestId={first.id} actorId={actorId} onSaved={load} />
        )}
        {group.rows.length > 1 && <span style={chipStyle('neutral')}>{group.rows.length} companies</span>}
      </>
    );

    if (compact) {
      return (
        <div onClick={() => navigate(`/onboarding/ch-codes/${first.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 14px', cursor: 'pointer', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 150, flex: '1 1 150px' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{first.person?.name || '—'}</span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}> · {entityLabel}</span>
          </div>
          {badges}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {chasing && <EmailCounter value={rep.emails_sent} onSave={(v) => actGroup(group, (row) => setEmailsSent(row.id, v))} />}
            <StageControls group={group} />
          </div>
        </div>
      );
    }

    return (
      <div onClick={() => navigate(`/onboarding/ch-codes/${first.id}`)}
        style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 180 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{first.person?.name || '—'}</div>
            <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 2 }}>{entityLabel}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{badges}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          {chasing && <EmailCounter value={rep.emails_sent} onSave={(v) => actGroup(group, (row) => setEmailsSent(row.id, v))} />}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
            {age != null ? `${age}d in stage` : ''}
          </span>
        </div>
        <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 12, paddingTop: 12 }}>
          <StageControls group={group} />
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

      {/* Chase-ladder summary across the open chasing stages */}
      <div style={{ display: 'flex', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fff', marginBottom: 6, flexWrap: 'wrap' }}>
        {[
          ['0 emails', summary.not_started, { bg: '#f8fafc', fg: '#475569' }],
          ['1 email', summary.one_email, tones.info],
          ['2 emails', summary.two_emails, tones.warning],
          ['3 emails · call due', summary.three_emails, tones.danger],
          ['Called', summary.called, tones.accent],
          ['Escalated', summary.escalated, tones.danger],
        ].map(([label, val, t], i) => (
          <div key={label} style={{ flex: '1 1 110px', minWidth: 104, padding: '10px 14px', borderLeft: i ? '1px solid #f1f5f9' : 'none' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: t.fg }}>{val}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>Across the {summary.total} people being chased (Stages 1, 3a, 3b, 4) — 3 emails triggers a call.</span>
        {totalQueued > 0 && (
          <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>
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
            const groups = grouped[g.value] || [];
            const showEmpty = !g.terminal && filter !== 'submitted';
            if (groups.length === 0 && !showEmpty) return null;
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
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{groups.length}</span>
                </button>
                {!isCollapsed && (groups.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', padding: '2px 2px 12px' }}>Nobody at this stage.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 12 }}>
                    {groups.map((group) => <Tile key={group.key} group={group} />)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {callFor && (
        <CallLogModal group={callFor} busy={busyId === callFor.key}
          onCancel={() => setCallFor(null)}
          onConfirm={async ({ calledAt, outcome, note }) => {
            const group = callFor; setCallFor(null);
            await actGroup(group, (row) => setComms(row, 'called', { actorId, calledAt, outcome, note }),
              `Call logged for ${group.rows[0].person?.name || 'client'} — ${callOutcomeMeta(outcome)?.label || outcome}.`);
          }} />
      )}
    </div>
  );
}
