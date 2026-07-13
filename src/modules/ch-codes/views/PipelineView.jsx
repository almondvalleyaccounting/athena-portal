import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, PhoneCall, Ban, Mail, Send, IdCard, KeyRound, Check, Rows3, LayoutGrid } from 'lucide-react';
import { chipStyle, pillStyle, tones } from '../../../lib/tokens';
import ChSubNav from '../components/ChSubNav';
import { useAuth } from '../../../shell/AppShell';
import {
  listChCodeRequests, CH_CODE_STATUSES, HANDLING_OPTIONS, CH_STAGES, stageOf, daysSince,
  setHandling, setStage, setEmailsSent, queueEmail, queuedCountsByRequest,
} from '../api';

const font = "'Outfit', sans-serif";

function statusMeta(value) {
  return CH_CODE_STATUSES.find((s) => s.value === value) || CH_CODE_STATUSES[0];
}

// Section groups, in order: the five chase stages Sophie works through, then
// the terminal buckets. groupKey() maps a request to exactly one.
const GROUPS = [
  ...CH_STAGES,
  { value: 'entered_on_bm', label: 'Entered on BM', tone: 'success', terminal: true },
  { value: 'stalled', label: 'Stalled', tone: 'neutral', terminal: true },
];
function groupKey(r) {
  if (r.status === 'entered_on_bm') return 'entered_on_bm';
  if (r.status === 'stalled') return 'stalled';
  return stageOf(r);
}

// Inline, click-to-edit counter of emails sent. Sophie can seed it with the
// number already sent by hand before Athena tracked this person.
function EmailCounter({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => { setDraft(String(value ?? 0)); }, [value]);

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => { setEditing(false); if (String(value ?? 0) !== draft) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(String(value ?? 0)); setEditing(false); } }}
        style={{ width: 56, padding: '3px 6px', fontSize: 12, fontFamily: font, border: '1px solid #93c5fd', borderRadius: 7 }}
      />
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Emails sent — click to set the starting count"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: font }}
    >
      <Mail size={12} /> {value ?? 0} sent
    </button>
  );
}

// The chase-stage selector — this is what moves a tile between sections.
// Solid fill on the active stage so it reads as the primary control (the
// handling toggle below uses soft tints, keeping the two visually distinct).
function StageSelect({ value, onSet, disabled, compact }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
      {CH_STAGES.map((s) => {
        const active = value === s.value;
        const t = tones[s.tone] || tones.neutral;
        return (
          <button
            key={s.value}
            disabled={disabled}
            onClick={() => !active && onSet(s.value)}
            style={{
              fontSize: compact ? 10.5 : 11.5, fontWeight: active ? 700 : 500, fontFamily: font,
              padding: compact ? '2px 9px' : '4px 11px', borderRadius: 8,
              background: active ? t.solid : '#fff', color: active ? t.onSolid : '#64748b',
              border: `1px solid ${active ? t.solid : '#e5e7eb'}`,
              cursor: active ? 'default' : 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// The 4-state "who's doing it" toggle.
function HandlingToggle({ value, onSet, disabled, compact }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
      {HANDLING_OPTIONS.map((o) => {
        const active = value === o.value;
        const t = tones[o.tone] || tones.neutral;
        return (
          <button
            key={o.value}
            disabled={disabled}
            onClick={() => !active && onSet(o.value)}
            style={{
              fontSize: compact ? 10.5 : 11.5, fontWeight: active ? 700 : 500, fontFamily: font,
              padding: compact ? '2px 8px' : '4px 10px', borderRadius: 999,
              background: active ? t.bg : '#fff', color: active ? t.fg : '#94a3b8',
              border: `1px solid ${active ? t.border : '#e5e7eb'}`,
              cursor: active ? 'default' : 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SendButton({ icon: Icon, label, onClick, disabled, tone = 'info' }) {
  const t = tones[tone] || tones.info;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: font,
        fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8,
        background: '#fff', color: disabled ? '#cbd5e1' : t.fg,
        border: `1px solid ${disabled ? '#eef2f6' : t.border}`, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

export default function PipelineView() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [rows, setRows] = useState(null);
  const [queuedCounts, setQueuedCounts] = useState({});
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [filter, setFilter] = useState('open'); // open | done | all
  const [search, setSearch] = useState('');
  const [compact, setCompact] = useState(true);

  const load = () => Promise.all([listChCodeRequests(), queuedCountsByRequest()])
    .then(([data, counts]) => { setRows(data); setQueuedCounts(counts); })
    .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const totalQueued = useMemo(() => Object.values(queuedCounts).reduce((a, b) => a + b, 0), [queuedCounts]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (filter === 'open' && ['entered_on_bm', 'stalled'].includes(r.status)) return false;
      if (filter === 'done' && r.status !== 'entered_on_bm') return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.person?.name?.toLowerCase().includes(q) && !r.entity?.name?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  const grouped = useMemo(() => {
    const m = {};
    for (const r of filtered) (m[groupKey(r)] ||= []).push(r);
    return m;
  }, [filtered]);

  const counts = useMemo(() => {
    if (!rows) return { callNeeded: 0, escalated: 0 };
    return {
      callNeeded: rows.filter((r) => r.escalation_status === 'call_needed').length,
      escalated: rows.filter((r) => r.escalation_status === 'escalated_tracy').length,
    };
  }, [rows]);

  async function act(id, fn, msg) {
    setBusyId(id); setError(null); setFlash(null);
    try { await fn(); await load(); if (msg) setFlash(msg); }
    catch (e) { setError(e.message); }
    setBusyId(null);
  }

  const done = (r) => ['entered_on_bm', 'stalled'].includes(r.status);

  function TileActions({ r }) {
    const busy = busyId === r.id;
    if (done(r)) {
      return r.status === 'entered_on_bm'
        ? <span style={{ fontSize: 12, color: tones.success.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> Complete</span>
        : <span style={{ fontSize: 12, color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ban size={12} /> Stalled</span>;
    }
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SendButton
          icon={Send} label="Queue offer" disabled={busy}
          onClick={() => act(r.id, () => queueEmail(r, 'offer', { actorId: profile?.id }), `Offer queued for ${r.person?.name || 'client'}.`)}
        />
        <SendButton
          icon={Mail} label="Remind: decision" tone="warning" disabled={busy}
          onClick={() => act(r.id, () => queueEmail(r, 'reminder', { actorId: profile?.id }), `Reminder queued for ${r.person?.name || 'client'}.`)}
        />
        {r.decision === 'paid' && (
          <SendButton
            icon={IdCard} label="Remind: ID & POA" tone="accent" disabled={busy}
            onClick={() => act(r.id, () => queueEmail(r, 'id_poa', { actorId: profile?.id }), `ID & POA reminder queued for ${r.person?.name || 'client'}.`)}
          />
        )}
        {r.status === 'awaiting_code' && (
          <SendButton
            icon={KeyRound} label="Remind: code" tone="success" disabled={busy}
            onClick={() => act(r.id, () => queueEmail(r, 'code', { actorId: profile?.id }), `Code reminder queued for ${r.person?.name || 'client'}.`)}
          />
        )}
      </div>
    );
  }

  function Tile({ r }) {
    const meta = statusMeta(r.status);
    const age = daysSince(r.requested_at);
    const queued = queuedCounts[r.id] || 0;
    const busy = busyId === r.id;
    const stage = stageOf(r);
    const isDone = done(r);

    if (compact) {
      return (
        <div
          onClick={() => navigate(`/onboarding/ch-codes/${r.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
        >
          <div style={{ minWidth: 160, flex: '1 1 160px' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{r.person?.name || '—'}</span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}> · {r.entity?.name || '—'}</span>
          </div>
          <span style={chipStyle(meta.tone)}>{meta.label}</span>
          {queued > 0 && <span style={chipStyle('info')}>{queued} queued</span>}
          {!isDone && <StageSelect value={stage} onSet={(v) => act(r.id, () => setStage(r, v, { actorId: profile?.id }))} disabled={busy} compact />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <EmailCounter value={r.emails_sent} onSave={(v) => act(r.id, () => setEmailsSent(r.id, v))} />
            <TileActions r={r} />
          </div>
        </div>
      );
    }

    return (
      <div
        onClick={() => navigate(`/onboarding/ch-codes/${r.id}`)}
        style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px', cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 180 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>{r.person?.name || '—'}</div>
            <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 2 }}>{r.entity?.name || '—'}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={chipStyle(meta.tone)}>{meta.label}</span>
            <span style={{ fontSize: 12, color: '#64748b' }}>{r.decision ? (r.decision === 'paid' ? '💳 We do it' : '🙋 Self') : ''}</span>
            {queued > 0 && <span style={chipStyle('info')}>{queued} queued</span>}
            {!r.person?.email && !isDone && <span style={chipStyle('warning')}>no email</span>}
          </div>
        </div>

        {!isDone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, width: 68 }}>Stage</span>
            <StageSelect value={stage} onSet={(v) => act(r.id, () => setStage(r, v, { actorId: profile?.id }))} disabled={busy} />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, width: 68 }}>Who's on it</span>
          <HandlingToggle value={r.handling} onSet={(v) => act(r.id, () => setHandling(r.id, v, { actorId: profile?.id }))} disabled={busy} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <EmailCounter value={r.emails_sent} onSave={(v) => act(r.id, () => setEmailsSent(r.id, v))} />
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {age != null ? `${age}d since offer` : ''}{r.chase_count > 0 ? ` · ${r.chase_count} auto-chase${r.chase_count === 1 ? '' : 's'}` : ''}
            </span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 14, paddingTop: 12 }}>
          <TileActions r={r} />
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
            Chasing directors &amp; PSCs for their CH identity-verification code, ahead of Confirmation Statement filing
          </p>
        </div>
        <ChSubNav active="Pipeline" queuedCount={totalQueued} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {counts.callNeeded > 0 && (
          <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <PhoneCall size={11} /> {counts.callNeeded} need a call
          </span>
        )}
        {counts.escalated > 0 && (
          <span style={{ ...chipStyle('danger'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <AlertTriangle size={11} /> {counts.escalated} escalated to Tracy
          </span>
        )}
        {totalQueued > 0 && (
          <button
            onClick={() => navigate('/onboarding/ch-codes/queue')}
            style={{ ...chipStyle('info'), display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, border: 'none', cursor: 'pointer' }}
          >
            <Send size={11} /> {totalQueued} email{totalQueued === 1 ? '' : 's'} queued — review &amp; send
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['done', 'Entered on BM'], ['all', 'All']].map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} style={pillStyle({ tone: 'info', active: filter === v })}>
            {label}
          </button>
        ))}
        <button
          onClick={() => setCompact((c) => !c)}
          title={compact ? 'Switch to comfortable tiles' : 'Switch to compact rows'}
          style={{ ...pillStyle({ tone: 'neutral', active: compact }), display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {compact ? <LayoutGrid size={13} /> : <Rows3 size={13} />} {compact ? 'Comfortable' : 'Compact'}
        </button>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search person or company…"
          style={{ marginLeft: 'auto', padding: '7px 12px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 8, minWidth: 220, background: '#fff' }}
        />
      </div>

      {flash && (
        <div style={{ background: tones.success.bg, color: tones.success.fg, borderRadius: 10, padding: '9px 14px', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Check size={14} /> {flash}
          <button onClick={() => navigate('/onboarding/ch-codes/queue')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: tones.success.fg, fontWeight: 700, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', fontFamily: font }}>
            Go to queue →
          </button>
        </div>
      )}
      {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>Failed: {error}</div>}
      {!rows && !error && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}

      {rows && filtered.length === 0 && (
        <div style={{ background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
          Nothing here. The daily chaser seeds new requests automatically for directors/PSCs without a code on file.
        </div>
      )}

      {rows && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {GROUPS.map((g) => {
            const groupRows = grouped[g.value] || [];
            // Always show the five working stages (even empty) so the board is
            // stable; terminal buckets only appear when they hold something.
            const showEmpty = !g.terminal && filter !== 'done';
            if (groupRows.length === 0 && !showEmpty) return null;
            const t = tones[g.tone] || tones.neutral;
            return (
              <div key={g.value}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: t.solid, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.4 }}>{g.label}</span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{groupRows.length}</span>
                </div>
                {groupRows.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', padding: '4px 2px 2px' }}>Nobody at this stage.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 12 }}>
                    {groupRows.map((r) => <Tile key={r.id} r={r} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
