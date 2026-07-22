import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Sparkles } from 'lucide-react';
import { listInduction, startInduction, toggleInductionItem } from '../../api';
import { btn, DEFAULT_INDUCTION, fmtDateShort } from '../../recruitmentShared';

// New-starter induction checklist. Deliberately manual: "Start induction"
// seeds the default checklist; creating an Athena login stays a separate
// admin action (one of the checklist items), never automatic — nobody
// outside AVA staff ever gets provisioned by this flow.
export default function InductionPanel({ app, staffMap, profileId }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    listInduction(app.id).then((i) => { if (live) setItems(i); }).catch((e) => { setItems([]); setError(e.message); });
    return () => { live = false; };
  }, [app.id]);

  async function start() {
    setBusy(true); setError(null);
    try { setItems(await startInduction(app.id, DEFAULT_INDUCTION)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function toggle(item) {
    const next = !item.done;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done: next, done_by: next ? profileId : null, done_at: next ? new Date().toISOString() : null } : i)));
    try { await toggleInductionItem(item.id, next, profileId); }
    catch (e) { setError(e.message); listInduction(app.id).then(setItems); }
  }

  if (items === null) return <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>;

  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 8px' }}>
        <Sparkles size={22} color="#0e7fe0" style={{ marginBottom: 8 }} />
        <div style={{ fontSize: 13, color: '#334155', marginBottom: 4 }}>No induction started yet.</div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>
          Kick off the new-starter checklist when this candidate has accepted.
        </div>
        {error && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>{error}</div>}
        <button onClick={start} disabled={busy} style={btn('primary')}>{busy ? 'Starting…' : 'Start induction'}</button>
      </div>
    );
  }

  const done = items.filter((i) => i.done).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, height: 6, background: '#f1f5f9', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${(done / items.length) * 100}%`, height: '100%', background: '#16a34a' }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>{done}/{items.length}</span>
      </div>
      {error && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((item) => (
          <button key={item.id} onClick={() => toggle(item)}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 9, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '7px 4px', borderBottom: '1px solid #f8fafc', fontFamily: "'Outfit', sans-serif" }}>
            {item.done ? <CheckCircle2 size={16} color="#16a34a" style={{ flexShrink: 0, marginTop: 1 }} /> : <Circle size={16} color="#cbd5e1" style={{ flexShrink: 0, marginTop: 1 }} />}
            <span style={{ flex: 1 }}>
              <span style={{ fontSize: 13, color: item.done ? '#94a3b8' : '#0f172a', textDecoration: item.done ? 'line-through' : 'none' }}>{item.label}</span>
              {item.done && item.done_by && (
                <span style={{ display: 'block', fontSize: 10.5, color: '#cbd5e1', marginTop: 1 }}>
                  {staffMap[item.done_by] || 'staff'}{item.done_at ? ` · ${fmtDateShort(item.done_at)}` : ''}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
