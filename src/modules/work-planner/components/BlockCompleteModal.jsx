import React, { useState } from 'react';
import { formatISO, formatDateFull } from '../lib/helpers';
import { kindOf, callStandingBlocks } from '../lib/blocksApi';
import { BTN } from '../../../lib/buttonStyles';

// Opened by clicking a standing block on the Calendar. Shows the sub-tasks
// (payroll clients) and takes the minutes either per client or as one total.
// Complete writes completed_tasks and the timesheet through the edge function.

const font = "'Outfit', sans-serif";
const inputStyle = { padding: '6px 8px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: '#0f172a', outline: 'none' };

export default function BlockCompleteModal({ instance, block, items = [], entityMap, onDone, onEdit, onClose }) {
  const kind = kindOf(block?.block_kind);
  const [mode, setMode] = useState(items.length ? 'items' : 'total');
  const [mins, setMins] = useState(() => Object.fromEntries(items.map((it) => [it.id, it.minutes_default != null ? String(it.minutes_default) : ''])));
  const [total, setTotal] = useState(String(block?.duration || 60));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [explain, setExplain] = useState(false);
  const occ = formatISO(instance._date);
  const carry = !!block?.carry_over;
  const itemTotal = items.reduce((s, it) => s + (Number(mins[it.id]) || 0), 0);

  const submit = async (notRequired) => {
    setBusy(true); setErr(null);
    try {
      await callStandingBlocks({
        action: 'complete', block_id: block.id, occurrence_date: occ, not_required: notRequired, note: note || null,
        minutes: mode === 'total' ? Number(total) || 0 : 0,
        items: mode === 'items' ? items.map((it) => ({ entity_id: it.entity_id, label: it.label || entityMap?.[it.entity_id]?.name || null, minutes: Number(mins[it.id]) || 0 })) : [],
      });
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, width: 460, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontFamily: font }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 2 }}>{block?.title || instance.title}</h3>
        <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 12 }}>{kind.label} · {formatDateFull(instance._date)} · {Math.round((block?.duration || 0) / 6) / 10}h planned</div>

        {items.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}><input type="radio" checked={mode === 'items'} onChange={() => setMode('items')} style={{ accentColor: '#0e7fe0' }} />Time by client</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}><input type="radio" checked={mode === 'total'} onChange={() => setMode('total')} style={{ accentColor: '#0e7fe0' }} />One total</label>
          </div>
        )}

        {mode === 'items' ? (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 10 }}>
            {items.map((it) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13.5 }}>
                <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entityMap?.[it.entity_id]?.name || it.label || 'Sub-task'}</div>
                <input type="number" min={0} step={5} value={mins[it.id]} onChange={(e) => setMins((m) => ({ ...m, [it.id]: e.target.value }))} placeholder="0" style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
                <span style={{ fontSize: 12, color: '#94a3b8', width: 28 }}>min</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '6px 10px', fontSize: 12.5, color: '#475569', background: '#f8fafc' }}>
              Total {itemTotal} min · {Math.round(itemTotal / 6) / 10}h
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <label style={{ fontSize: 12.5, color: '#64748b' }}>Minutes spent</label>
            <input type="number" min={0} step={5} value={total} onChange={(e) => setTotal(e.target.value)} autoFocus style={{ ...inputStyle, width: 90, textAlign: 'right' }} />
          </div>
        )}

        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={explain ? 'Why did it not happen? (needed)' : 'Note (optional)'} rows={2} autoFocus={explain} style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 8, borderColor: explain && !note.trim() ? '#f59e0b' : '#e5e7eb' }} />
        {err && <div style={{ fontSize: 12.5, color: '#991b1b', marginBottom: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', gap: 6, marginRight: 'auto' }}>
            <button onClick={() => onEdit(block)} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Edit block</button>
            {carry
              ? <button onClick={() => submit(true)} disabled={busy} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Not required today</button>
              : (explain
                ? <button onClick={() => submit(true)} disabled={busy || !note.trim()} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Save the reason</button>
                : <button onClick={() => setExplain(true)} disabled={busy} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Didn't happen…</button>)}
          </span>
          <button onClick={onClose} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => submit(false)} disabled={busy} style={{ ...BTN.primary.sm, cursor: 'pointer' }}>{busy ? 'Saving…' : 'Complete & log time'}</button>
        </div>
      </div>
    </div>
  );
}
