import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import { fetchOpenCycle, fetchMyItems, fetchReasons, submitItemResponse } from '../api';

const font = "'Outfit', sans-serif";

const CONFIDENCE = [
  { key: 'green', label: 'On track', colour: '#16a34a', bg: '#dcfce7' },
  { key: 'amber', label: 'At risk',  colour: '#b45309', bg: '#fef3c7' },
  { key: 'red',   label: 'Will miss', colour: '#b91c1c', bg: '#fee2e2' },
];

const BOX_LABEL = {
  deprioritised: 'Deprioritised', urgent: 'Urgent', expedite: 'Expedite', normal: 'Normal',
};
const MOVEMENT_STYLE = {
  new:       { label: 'New',       colour: '#0e7fe0', bg: '#dbeafe' },
  advanced:  { label: 'Advanced',  colour: '#16a34a', bg: '#dcfce7' },
  unchanged: { label: 'No change', colour: '#b45309', bg: '#fef3c7' },
  slipped:   { label: 'Slipped',   colour: '#b91c1c', bg: '#fee2e2' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function monthLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export default function MyReviewView() {
  const { profile } = useAuth();
  const [cycle, setCycle] = useState(null);
  const [items, setItems] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, r] = await Promise.all([fetchOpenCycle(), fetchReasons()]);
        if (cancelled) return;
        setCycle(c);
        setReasons(r);
        if (c) {
          const its = await fetchMyItems(c.id, profile.id);
          if (!cancelled) setItems(its);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profile.id]);

  const answered = useMemo(() => items.filter((i) => i.responded_at).length, [items]);

  function patchLocal(id, patch) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  if (loading) return <Msg>Loading your review…</Msg>;
  if (error) return <Msg colour="#dc2626">Error: {error}</Msg>;
  if (!cycle) return <Msg>No review cycle is open right now. Your manager opens one each month.</Msg>;
  if (items.length === 0) return <Msg>Nothing for you in the {monthLabel(cycle.period_month)} review — nicely on top of things. 👏</Msg>;

  return (
    <div style={{ fontFamily: font, padding: '18px 22px 48px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: '#0f172a' }}>My review — {monthLabel(cycle.period_month)}</h2>
        <span style={{ fontSize: 13, fontWeight: 600, color: answered === items.length ? '#16a34a' : '#0e7fe0' }}>
          {answered} / {items.length} answered
        </span>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 18, lineHeight: 1.5 }}>
        These jobs could have progressed but haven’t. For each, tell us <strong>when you’ll have it done</strong>, <strong>what’s blocking it</strong>, and how confident you are.
        BrightManager stays the record for status — this is just the bit BM can’t hold.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            reasons={reasons}
            responder={profile}
            onSaved={(updated) => patchLocal(item.id, updated)}
            onLocalChange={(patch) => patchLocal(item.id, patch)}
          />
        ))}
      </div>
    </div>
  );
}

function ItemCard({ item, reasons, responder, onSaved, onLocalChange }) {
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const answered = !!item.responded_at;

  const set = (patch) => { onLocalChange(patch); setDirty(true); };

  async function save() {
    setSaving(true);
    try {
      const updated = await submitItemResponse(item, {
        done_by: item.done_by,
        reason_code: item.reason_code,
        confidence: item.confidence,
        needs_help: item.needs_help,
        note: item.note,
      }, responder);
      onSaved(updated);
      setDirty(false);
    } catch (e) {
      alert('Could not save: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  const mv = MOVEMENT_STYLE[item.movement] || null;

  return (
    <div style={{
      border: `1px solid ${answered && !dirty ? '#bbf7d0' : '#e5e7eb'}`,
      borderRadius: 10, background: answered && !dirty ? '#f7fef9' : '#fff', padding: '12px 14px',
    }}>
      {/* Row 1: identity */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{item.client_name}</span>
        <Pill bg="#eef2ff" colour="#4338ca">{item.service === 'Self Assessment' ? 'SA' : 'Accounts'}</Pill>
        <span style={{ fontSize: 12, color: '#64748b' }}>YE {fmtDate(item.period_end)}</span>
        <span style={{ fontSize: 12, color: item.days_past > 365 ? '#dc2626' : '#64748b', fontWeight: item.days_past > 365 ? 600 : 400 }}>
          {item.days_past} days past
        </span>
        <Pill bg="#f1f5f9" colour="#475569">{item.bm_status_snapshot}</Pill>
        {BOX_LABEL[item.box] && <Pill bg="#f8fafc" colour="#64748b">{BOX_LABEL[item.box]}</Pill>}
        {mv && <Pill bg={mv.bg} colour={mv.colour}>{mv.label}</Pill>}
        <div style={{ flex: 1 }} />
        {answered && !dirty && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Saved</span>}
      </div>

      {/* Row 2: capture controls */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Done by">
          <input
            type="date"
            value={item.done_by || ''}
            onChange={(e) => set({ done_by: e.target.value })}
            style={inputStyle}
          />
        </Field>

        <Field label="What’s blocking it?">
          <select
            value={item.reason_code || ''}
            onChange={(e) => set({ reason_code: e.target.value })}
            style={{ ...inputStyle, minWidth: 240 }}
          >
            <option value="">— Select a reason —</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>{r.label}{r.triggers_client_chase ? ' ⟶ client' : ''}</option>
            ))}
          </select>
        </Field>

        <Field label="Confidence">
          <div style={{ display: 'flex', gap: 6 }}>
            {CONFIDENCE.map((c) => {
              const active = item.confidence === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => set({ confidence: active ? null : c.key })}
                  title={c.label}
                  style={{
                    fontSize: 11, fontWeight: 600, fontFamily: font, cursor: 'pointer',
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid ' + (active ? c.colour : '#cbd5e1'),
                    background: active ? c.bg : '#fff', color: active ? c.colour : '#94a3b8',
                  }}
                >{c.label}</button>
              );
            })}
          </div>
        </Field>

        <Field label="Need help?">
          <button
            type="button"
            onClick={() => set({ needs_help: !item.needs_help })}
            style={{
              fontSize: 12, fontWeight: 600, fontFamily: font, cursor: 'pointer',
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid ' + (item.needs_help ? '#b91c1c' : '#cbd5e1'),
              background: item.needs_help ? '#fee2e2' : '#fff', color: item.needs_help ? '#b91c1c' : '#64748b',
            }}
          >{item.needs_help ? '🙋 Flagged' : 'Raise'}</button>
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 12 }}>
        <Field label="Note (optional)" grow>
          <input
            type="text"
            value={item.note || ''}
            onChange={(e) => set({ note: e.target.value })}
            placeholder="Anything the manager should know"
            style={{ ...inputStyle, width: '100%' }}
          />
        </Field>
        <button
          onClick={save}
          disabled={saving || !dirty}
          style={{
            fontSize: 12, fontWeight: 600, fontFamily: font,
            cursor: saving || !dirty ? 'default' : 'pointer',
            padding: '8px 18px', borderRadius: 8, border: '1px solid #0f172a',
            background: !dirty ? '#94a3b8' : '#0f172a', borderColor: !dirty ? '#94a3b8' : '#0f172a',
            color: '#fff', whiteSpace: 'nowrap',
          }}
        >{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
      </div>
    </div>
  );
}

function Field({ label, children, grow }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: grow ? 1 : 'initial' }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</span>
      {children}
    </label>
  );
}

function Pill({ children, bg, colour }) {
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: bg, color: colour, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

const inputStyle = {
  padding: '7px 10px', fontSize: 13, fontFamily: font,
  border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#0f172a', outline: 'none',
};

function Msg({ children, colour = '#64748b' }) {
  return <div style={{ padding: 28, fontFamily: font, color: colour, fontSize: 14, textAlign: 'center' }}>{children}</div>;
}
