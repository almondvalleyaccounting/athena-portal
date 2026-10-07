import React, { useCallback, useEffect, useState } from 'react';
import { callJobPlan } from '../plan/planQueries';
import { BTN } from '../../../lib/buttonStyles';

// A director's other income for one self assessment (sql/351): the personal
// items asked for on their company's records request, ticked as each one
// arrives. While any is outstanding the return shows as waiting on the
// Priority board. Ticking will later be an agent's job too.

const font = "'Outfit', sans-serif";
const fmt = (ts) => (ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function IncomeItemsModal({ job, staffMap, onClose, onChanged }) {
  // job: { entity_id, period_end, client, follows? }
  const [items, setItems] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [add, setAdd] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await callJobPlan({ action: 'income_items', entity_id: job.entity_id, period_end: job.period_end });
      setItems(r.items || []); setCatalogue(r.catalogue || []);
    } catch (e) { setError(e.message || String(e)); }
  }, [job.entity_id, job.period_end]);
  useEffect(() => { load(); }, [load]);

  const run = async (payload) => {
    setBusy(true); setError(null);
    try { await callJobPlan(payload); await load(); onChanged && onChanged(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const labelOf = (it) => (it.item_key ? catalogue.find((c) => c.key === it.item_key)?.label || it.item_key : it.custom_text);
  const open = items.filter((i) => !i.received_at).length;
  const unused = catalogue.filter((c) => !items.some((i) => i.item_key === c.key));

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.3)', zIndex: 115, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 520, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', padding: 18, fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>Other income</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{job.client}</div>
            <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
              {open ? `${open} outstanding — the return waits until they're all in.` : items.length ? 'Everything is in.' : 'Nothing asked for yet.'}
              {job.follows?.company ? ` Follows ${job.follows.company}.` : ''}
            </div>
          </div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>
        {error && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>{error}</div>}
        <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 8 }}>
          {items.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: '#94a3b8' }}>Items appear here when the company's records request asks for them for this director, or add one below.</div>}
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 }}>
              <input type="checkbox" checked={!!it.received_at} disabled={busy} onChange={(e) => run({ action: 'income_item_received', id: it.id, received: e.target.checked })} />
              <span style={{ flex: 1, color: it.received_at ? '#64748b' : '#0f172a', textDecoration: it.received_at ? 'line-through' : 'none' }}>{labelOf(it)}</span>
              <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                {it.received_at ? `in ${fmt(it.received_at)}${it.received_by ? ` · ${(staffMap?.[it.received_by]?.name || '').split(' ')[0]}` : ''}` : it.requested_at ? `asked ${fmt(it.requested_at)}` : 'not asked yet'}
              </span>
              {!it.received_at && <button disabled={busy} onClick={() => { if (window.confirm(`Remove "${labelOf(it)}"?`)) run({ action: 'income_item_remove', id: it.id }); }} style={{ ...BTN.secondary.sm, padding: '0 7px' }}>×</button>}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={add} onChange={(e) => setAdd(e.target.value)} style={{ padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, flex: 1, minWidth: 180 }}>
            <option value="">Add an item…</option>
            {unused.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            <option value="__custom">Something else…</option>
          </select>
          {add === '__custom' && <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="What's outstanding" style={{ padding: '5px 8px', fontSize: 13, fontFamily: font, border: '1px solid #cbd5e1', borderRadius: 6, flex: 1, minWidth: 160 }} />}
          <button disabled={busy || !add || (add === '__custom' && !custom.trim())} onClick={async () => {
            await run(add === '__custom' ? { action: 'income_item_add', entity_id: job.entity_id, period_end: job.period_end, custom_text: custom.trim() } : { action: 'income_item_add', entity_id: job.entity_id, period_end: job.period_end, item_key: add });
            setAdd(''); setCustom('');
          }} style={BTN.primary.sm}>Add</button>
        </div>
      </div>
    </div>
  );
}
