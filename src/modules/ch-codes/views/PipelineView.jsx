import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, PhoneCall, Mail, Send, IdCard, KeyRound, Check, Rows3, LayoutGrid,
  ArrowRight, Ban, RotateCcw, FileText, Building2, ChevronDown, ChevronRight, MoreHorizontal,
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
  affectedCompanies,
} from '../api';
import { BTN } from '../../../lib/buttonStyles';

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

const fieldStyle = { width: '100%', padding: '9px 11px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box' };
const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 700, color: '#64748b', margin: '12px 0 5px' };

function CallLogModal({ group, onConfirm, onCancel, busy }) {
  const [dt, setDt] = useState(localNowValue);
  const [outcome, setOutcome] = useState(CALL_OUTCOMES[0].value);
  const [note, setNote] = useState('');
  const name = group.rows[0].person?.name || 'this person';
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: font }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 400, maxWidth: '92vw', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <PhoneCall size={16} color={tones.accent.solid} />
          <div style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>Log a call</div>
        </div>
        <p style={{ margin: '0 0 2px', fontSize: 14, color: '#64748b' }}>When did you call {name}, and what happened?</p>

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
          <button onClick={onCancel} disabled={busy} style={{ ...BTN.secondary.md, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => dt && onConfirm({ calledAt: new Date(dt).toISOString(), outcome, note })} disabled={!dt || busy}
            style={{ padding: '8px 16px', fontSize: 14, fontWeight: 700, fontFamily: font, background: (!dt || busy) ? '#e5e7eb' : tones.accent.solid, color: (!dt || busy) ? '#94a3b8' : '#fff', border: 'none', borderRadius: 9, cursor: (!dt || busy) ? 'not-allowed' : 'pointer' }}>
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
        style={{ width: 52, padding: '3px 6px', fontSize: 13, fontFamily: font, border: '1px solid #93c5fd', borderRadius: 7 }} />
    );
  }
  // Grey until the ladder runs out; red at 3+ (a call is due). The status pill
  // carries the rest, so the counter doesn't add a colour of its own per row.
  const n = value ?? 0;
  const t = n >= 3 ? tones.danger : { bg: '#f8fafc', border: '#e5e7eb', fg: '#475569' };
  return (
    <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Emails sent this stage — click to set"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 999, padding: '3px 9px', fontSize: 13, fontWeight: 700, color: t.fg, cursor: 'pointer', fontFamily: font }}>
      <Mail size={12} /> {n}/3
    </button>
  );
}

// One look for every row button: the shared primary / secondary / danger kinds.
// Colour is kept for status (the pill), not spread across the actions.
function Btn({ icon: Icon, label, onClick, disabled, kind = 'secondary', title }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick?.(); }} disabled={disabled} title={title}
      style={{
        ...BTN[kind].sm, opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: disabled ? 'not-allowed' : 'pointer',
      }}>
      {Icon && <Icon size={13} />} {label}
    </button>
  );
}

// The ⋯ menu at the end of each row: the less-used and destructive actions
// (escalate, reject/exit, other emails, a call when it isn't the next step).
function RowMenu({ items, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  // Keep the column the same width on rows with nothing to offer.
  if (!items.length) return <span style={{ width: 30 }} />;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} disabled={disabled} title="More actions" aria-label="More actions"
        style={{ ...BTN.secondary.sm, width: 30, padding: '5px 0', display: 'inline-flex', justifyContent: 'center', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 }}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.12)', padding: 4, minWidth: 190 }}>
          {items.map((it) => (
            <button key={it.key} title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 7, padding: '7px 10px', fontSize: 13, fontFamily: font, cursor: 'pointer', color: it.danger ? tones.danger.fg : '#334155', whiteSpace: 'nowrap' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
              {it.icon && <it.icon size={13} />} {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const QUEUE_BUTTONS = {
  s1_offer: [['offer', 'Queue offer', Send], ['reminder', 'Remind: decision', Mail]],
  s3a_client: [['self_verify', 'Remind: self-verify', Mail]],
  s3b_us: [['id_poa', 'Remind: ID & POA', IdCard]],
  s4_code: [['code', 'Remind: code', KeyRound]],
};

// The chase ladder: offer + 2 reminders = 3 emails, then a call.
//  - offer: the first email IS the offer, so once anything has gone it's done.
//  - reminders: greyed at 3 emails — the next action is a call.
const queueDisabled = (kind, emailsSent) => (kind === 'offer' ? emailsSent >= 1 : emailsSent >= 3);

// Columns shared by every row in a stage (subgrid), so pills and buttons line up:
// person · status · emails · next step · stage actions · ⋯
const ROW_COLUMNS = 'minmax(0, 1fr) auto auto auto auto auto';


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
        if (!r.person?.name?.toLowerCase().includes(q)
          && !affectedCompanies([r]).some((c) => c.name?.toLowerCase().includes(q))) return false;
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

  // Every state worth flagging on a row, most urgent first. The row shows only
  // the first as a pill; the rest sit in its tooltip and on the detail page.
  function statusItems(group) {
    const rep = repRow(group);
    const first = group.rows[0];
    const chasing = stageMeta(rep.stage).chasing;
    const out = [];
    const pill = (key, tone, label, title, Icon) => out.push({
      key, title: title || label,
      node: (
        <span key={key} title={title || label}
          style={{ ...chipStyle(tone), display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          {Icon && <Icon size={11} />}{label}
        </span>
      ),
    });

    if (chasing && isEscalated(rep)) pill('esc', 'danger', 'Escalated', 'Escalated — stays on the record until someone removes it deliberately', AlertTriangle);
    if (rep.stage === 's5_entered' && rep.bm_code_mismatch) pill('mismatch', 'danger', 'Code mismatch');
    if (chasing && rep.client_replied_at) {
      pill('replied', 'success', 'Replied', `Email reply received ${new Date(rep.client_replied_at).toLocaleString('en-GB')} — reminders held until the stage moves`, Mail);
    }
    if (!stageMeta(rep.stage).terminal && first.person?.id && !isEmail(first.person?.email)) {
      out.push({
        key: 'email', title: 'No email on file',
        node: <PersonEmail key="email" person={first.person} requestId={first.id} actorId={actorId} onSaved={load} />,
      });
    }
    if (chasing && (rep.called_at || rep.escalation_status === 'call_needed')) {
      const oc = callOutcomeMeta(rep.last_call_outcome);
      const when = rep.called_at ? new Date(rep.called_at) : null;
      const title = [
        when ? `Called ${when.toLocaleString('en-GB')}` : 'Call needed',
        oc ? `— ${oc.label}` : null,
        rep.last_call_note || null,
      ].filter(Boolean).join(' ');
      const label = when
        ? `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${oc && oc.value !== 'other' ? ` · ${oc.label}` : ''}`
        : 'Call needed';
      pill('call', oc?.tone || 'accent', label, title, PhoneCall);
    } else if (chasing && (rep.emails_sent || 0) >= 3) {
      pill('calldue', 'warning', 'Call due', '3 emails sent — a call is now required', PhoneCall);
    }
    if (rep.stage === 's3b_us' && group.rows.some((r) => r.billing_item_id)) pill('invoiced', 'accent', '£20+VAT invoiced');
    const queued = group.rows.reduce((sum, row) => sum + (queuedCounts[row.id] || 0), 0);
    if (queued > 0) pill('queued', 'info', `${queued} queued`, `${queued} email${queued === 1 ? '' : 's'} waiting in the send queue`);
    return out;
  }

  function StatusCell({ group }) {
    const items = statusItems(group);
    if (!items.length) return <span />;
    const [top, ...rest] = items;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {top.node}
        {rest.length > 0 && (
          <span title={rest.map((i) => i.title).join('\n')} style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>+{rest.length}</span>
        )}
      </span>
    );
  }

  // The one chase step that comes next on the ladder: offer → reminder → call.
  // Returns the button plus what it used, so the menu doesn't repeat it.
  function nextStep(group) {
    const rep = repRow(group);
    const first = group.rows[0];
    const busy = busyId === group.key;
    if (!stageMeta(rep.stage).chasing) return { node: <span />, kind: null, isCall: false };
    const emailsSent = rep.emails_sent || 0;
    if (emailsSent >= 3) {
      return { node: <Btn icon={PhoneCall} label="Log call" disabled={busy} onClick={() => setCallFor(group)} />, kind: null, isCall: true };
    }
    const qbtns = QUEUE_BUTTONS[rep.stage] || [];
    const pick = qbtns.find(([kind]) => !queueDisabled(kind, emailsSent));
    if (!pick) return { node: <span />, kind: null, isCall: false };
    const [kind, label, Icon] = pick;
    // One email covers every company in the group, so queue against the first request only.
    if ((queuedKinds[first.id] || {})[kind]) {
      return {
        node: <Btn icon={Check} label="In queue" title="Already in the send queue — open the queue to review it"
          onClick={() => navigate('/onboarding/ch-codes/queue')} />,
        kind, isCall: false,
      };
    }
    return { node: <Btn icon={Icon} label={label} disabled={busy} onClick={() => queueFor(group, first, kind, label)} />, kind, isCall: false };
  }

  function menuItems(group, next) {
    const rep = repRow(group);
    const first = group.rows[0];
    const stage = rep.stage;
    const chasing = stageMeta(stage).chasing;
    const emailsSent = rep.emails_sent || 0;
    const items = [];
    if (chasing && !next.isCall) items.push({ key: 'call', label: 'Log call', icon: PhoneCall, onClick: () => setCallFor(group) });
    for (const [kind, label, Icon] of QUEUE_BUTTONS[stage] || []) {
      if (kind === next.kind || queueDisabled(kind, emailsSent) || (queuedKinds[first.id] || {})[kind]) continue;
      items.push({ key: `q:${kind}`, label, icon: Icon, onClick: () => queueFor(group, first, kind, label) });
    }
    if (chasing && !isEscalated(rep)) {
      items.push({ key: 'esc', label: 'Escalate', icon: AlertTriangle, danger: true, title: 'Escalate (stays until removed).',
        onClick: () => actGroup(group, (row) => setComms(row, 'escalated', { actorId })) });
    }
    if (chasing && isEscalated(rep)) {
      items.push({ key: 'unesc', label: 'Remove escalation', icon: Ban, title: 'Only if escalated by mistake.',
        onClick: () => {
          if (!window.confirm(`Remove the escalation on ${first.person?.name || 'this request'}?

Escalation is meant to be permanent — only do this if it was applied by mistake.`)) return;
          actGroup(group, (row) => clearEscalation(row, { actorId }), 'Escalation removed.');
        } });
    }
    if (!stageMeta(stage).terminal) items.push({ key: 'reject', label: 'Reject / exit', icon: Ban, danger: true, onClick: () => reject(group) });
    return items;
  }

  // The stage-specific advance controls. Operates on a tile group — for
  // person-level stages this may fan out across >1 company.
  function StageActions({ group }) {
    const rep = repRow(group);
    const busy = busyId === group.key;
    const stage = rep.stage;
    const first = group.rows[0];
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
        {stage === 's1_offer' && (
          <Btn icon={ArrowRight} label="Record decision" kind="primary" disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's2_decision', { actorId }))} />
        )}
        {stage === 's2_decision' && (
          <>
            <Btn icon={Check} label="Client is doing it" kind="primary" disabled={busy} onClick={() => actGroup(group, (row) => recordDecision(row, 'self', { actorId }), `${first.person?.name || 'Client'} → self-verifying (Stage 3a).`)} />
            <Btn icon={FileText} label="We're doing it (£20+VAT)" disabled={busy} onClick={() => decideWeDoIt(group)} />
            <Btn icon={RotateCcw} label="Back to Stage 1" disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's1_offer', { actorId }))} />
          </>
        )}
        {stage === 's3a_client' && (
          <Btn icon={ArrowRight} label="Move to awaiting code" kind="primary" disabled={busy} onClick={() => actGroup(group, (row) => advanceStage(row, 's4_code', { actorId }), `${first.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's3b_us' && (
          <Btn icon={ArrowRight} label="ID & POA received" kind="primary" disabled={busy} onClick={() => actGroup(group, (row) => recordIdPoaReceived(row, { actorId }), `${first.person?.name || 'Client'} → awaiting code (Stage 4).`)} />
        )}
        {stage === 's4_code' && (
          <span style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <input value={codeDraft[group.key] || ''} onChange={(e) => setCodeDraft((d) => ({ ...d, [group.key]: e.target.value }))}
              placeholder="FT5-15ED-7JY5"
              style={{ padding: '5px 9px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, width: 130 }} />
            <Btn icon={Check} label="Save code" kind="primary" disabled={busy || !(codeDraft[group.key] || '').trim()}
              onClick={() => actGroup(group, (row) => recordCodeReceived(row, codeDraft[group.key], { actorId }), `Code saved for ${first.person?.name || 'client'} (Stage 5).`).then(() => setCodeDraft((d) => ({ ...d, [group.key]: '' })))} />
          </span>
        )}
        {stage === 's5_entered' && (
          <>
            <Btn icon={rep.entered_inform_direct_at ? Check : Building2} label="Inform Direct" disabled={busy}
              title={rep.entered_inform_direct_at ? 'Entered in Inform Direct — click to undo' : 'Mark as entered in Inform Direct'}
              onClick={() => actGroup(group, (row) => markInformDirect(row, !row.entered_inform_direct_at, { actorId }))} />
            <Btn icon={rep.entered_bm_at ? Check : Building2} label="BM" disabled={busy}
              title={rep.entered_bm_at ? 'Entered in BM — click to undo' : 'Mark as entered in BM'}
              onClick={() => actGroup(group, (row) => markEnteredBm(row, !row.entered_bm_at, { actorId }))} />
            <Btn icon={Check} label="Mark submitted" kind="primary"
              disabled={busy || !rep.entered_inform_direct_at || !rep.entered_bm_at}
              onClick={() => actGroup(group, (row) => submitRequest(row, { actorId }), `${first.person?.name || 'Request'} filed (Stage 6).`)} />
          </>
        )}
        {stage === 's6_submitted' && (
          <>
            <span style={{ fontSize: 13, color: tones.success.fg, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
              <Check size={13} /> Filed{rep.submitted_at ? ` ${new Date(rep.submitted_at).toLocaleDateString('en-GB')}` : ''}
            </span>
            <Btn icon={RotateCcw} label="Reopen" disabled={busy} onClick={() => actGroup(group, (row) => reopenRequest(row, { actorId }))} />
          </>
        )}
        {stage === 's7_rejected' && (
          <>
            <span style={{ fontSize: 13, color: tones.danger.fg, display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={rep.rejected_reason || 'Rejected / exited'}>
              <Ban size={12} /> {rep.rejected_reason || 'Rejected / exited'}
            </span>
            <Btn icon={RotateCcw} label="Reopen" disabled={busy} onClick={() => actGroup(group, (row) => reopenRequest(row, { actorId }))} />
          </>
        )}
      </span>
    );
  }

  function Tile({ group }) {
    const rep = repRow(group);
    const first = group.rows[0];
    const busy = busyId === group.key;
    const chasing = stageMeta(rep.stage).chasing;
    const age = daysSince(rep.requested_at);
    // Every company held up by this person's missing code, not only the ones
    // a request is anchored on. One line on the row; the full list in the tooltip.
    const companies = affectedCompanies(group.rows);
    const companyLabel = companies.length
      ? `${companies[0].name}${companies.length > 1 ? ` +${companies.length - 1} more` : ''}`
      : '—';
    const companyTitle = companies.map((c) => `${c.name}${c.chased ? '' : ' (also needs this code — no chase on it)'}`).join('\n');
    const next = nextStep(group);
    const menu = <RowMenu items={menuItems(group, next)} disabled={busy} />;
    const emails = chasing
      ? <EmailCounter value={rep.emails_sent} onSave={(v) => actGroup(group, (row) => setEmailsSent(row.id, v))} />
      : <span />;
    const open = () => navigate(`/onboarding/ch-codes/${first.id}`);

    if (compact) {
      return (
        <div onClick={open}
          style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 14px', cursor: 'pointer', minHeight: 46, boxSizing: 'border-box' }}>
          <div style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={companyTitle}>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: '#0f172a' }}>{first.person?.name || '—'}</span>
            <span style={{ fontSize: 13, color: '#94a3b8' }}> · {companyLabel}</span>
          </div>
          <StatusCell group={group} />
          {emails}
          {next.node}
          <StageActions group={group} />
          {menu}
        </div>
      );
    }

    return (
      <div onClick={open}
        style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }} title={companyTitle}>
            <div style={{ fontSize: 15.5, fontWeight: 600, color: '#0f172a' }}>{first.person?.name || '—'}</div>
            <div style={{ fontSize: 13.5, color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{companyLabel}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <StatusCell group={group} />
            {emails}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #f1f5f9', marginTop: 12, paddingTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>{age != null ? `${age}d in stage` : ''}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {next.node}
            <StageActions group={group} />
            {menu}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px', fontFamily: font }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>Companies House personal codes</h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: '#64748b' }}>
            Directors and PSCs by stage
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
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: '#94a3b8' }}>Across the {summary.total} people being chased (Stages 1, 3a, 3b, 4) — 3 emails triggers a call.</span>
        {totalQueued > 0 && (
          <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>
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
          style={{ marginLeft: 'auto', padding: '7px 12px', fontSize: 14, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff' }} />
      </div>

      {flash && (
        <div style={{ background: tones.success.bg, color: tones.success.fg, borderRadius: 10, padding: '9px 14px', fontSize: 14, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Check size={14} /> {flash}
          {totalQueued > 0 && <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: tones.success.fg, fontWeight: 700, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', fontFamily: font }}>Go to queue →</button>}
        </div>
      )}
      {error && <div style={{ color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>Failed: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 14 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{ background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14.5 }}>
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
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4 }}>{g.short}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{g.label}</span>
                  <span style={{ fontSize: 13, color: '#94a3b8' }}>{groups.length}</span>
                </button>
                {!isCollapsed && (groups.length === 0 ? (
                  <div style={{ fontSize: 13.5, color: '#cbd5e1', padding: '2px 2px 12px' }}>Nobody at this stage.</div>
                ) : (
                  <div style={compact
                    ? { display: 'grid', gridTemplateColumns: ROW_COLUMNS, columnGap: 12, rowGap: 6 }
                    : { display: 'flex', flexDirection: 'column', gap: 12 }}>
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
