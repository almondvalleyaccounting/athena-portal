import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Search, X, ChevronDown } from 'lucide-react';
import { fmtGbpDetailed } from '../../lib/money';
import { font, TAX_META, TAX_ORDER } from './hmrcShared';

// The one client selector for the whole module.
//
// It used to be per tab: the Client tab had one, the statement had another
// keyed on PAYE reference instead of entity, and the tax tabs had none at all —
// so moving from a client's VAT to their Corporation Tax meant finding them
// twice. This sits above the tabs, writes `?entity=` and every tax tab reads it,
// which is what makes the four heads feel like one client rather than four
// lists that happen to share a name.
//
// The dropdown shows the client's balance on the tax you are currently looking
// at, not their overall total. On the VAT tab the question is who owes VAT.

const n = (v) => Number(v || 0);

export default function ClientSelector({ clients, entityId, onPick, taxKey }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const chosen = clients.find((c) => c.entity_id === entityId);
  const key = TAX_META[taxKey]?.totalsKey;

  // Whoever owes the most on this tax first — the list is for finding work, and
  // alphabetical order buries it. A search jumps straight to a name anyway.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = clients.filter((c) => !needle || (c.entity_name || '').toLowerCase().includes(needle));
    return [...out]
      .sort((a, b) => {
        const d = n(b[key]) - n(a[key]);
        return d !== 0 ? d : (a.entity_name || '').localeCompare(b.entity_name || '');
      })
      .slice(0, 200);
  }, [clients, q, key]);

  return (
    <div ref={box} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => { setOpen((v) => !v); setQ(''); }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px',
          fontSize: 12.5, fontFamily: font, borderRadius: 8, cursor: 'pointer',
          background: chosen ? '#eff6ff' : '#fff',
          border: `1px solid ${chosen ? '#bfdbfe' : '#e5e7eb'}`,
          color: chosen ? '#0f172a' : '#64748b',
          minWidth: 240, textAlign: 'left',
        }}
      >
        <Search size={12} style={{ color: '#94a3b8', flexShrink: 0 }} />
        <span style={{ fontWeight: chosen ? 600 : 400, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {chosen ? chosen.entity_name : 'All clients — pick one to drill in'}
        </span>
        <ChevronDown size={12} style={{ color: '#94a3b8', flexShrink: 0 }} />
      </button>

      {chosen && (
        <button
          onClick={() => onPick('')}
          title="Back to every client"
          style={{
            marginLeft: 6, padding: '5px 7px', background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: 8, cursor: 'pointer', color: '#94a3b8', lineHeight: 0,
          }}
        >
          <X size={12} />
        </button>
      )}

      {open && (
        <div style={{
          position: 'absolute', zIndex: 40, top: 'calc(100% + 5px)', left: 0, width: 380,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(15,23,42,0.12)', overflow: 'hidden',
        }}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Client name…"
            style={{
              width: '100%', padding: '9px 12px', fontSize: 12.5, fontFamily: font,
              border: 'none', borderBottom: '1px solid #f1f5f9', outline: 'none', boxSizing: 'border-box',
            }}
          />
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {shown.length === 0 && (
              <div style={{ padding: '12px 14px', fontSize: 12, color: '#94a3b8' }}>No clients match.</div>
            )}
            {shown.map((c) => {
              const here = n(c[key]);
              return (
                <button
                  key={c.entity_id}
                  onClick={() => { onPick(c.entity_id); setOpen(false); }}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left',
                    padding: '7px 12px', background: c.entity_id === entityId ? '#f1f5f9' : 'none',
                    border: 'none', borderBottom: '1px solid #f8fafc', cursor: 'pointer',
                    fontFamily: font, fontSize: 12.5,
                  }}
                >
                  <span style={{ fontWeight: 500, color: '#0f172a', flex: 1 }}>{c.entity_name}</span>
                  {here !== 0 && (
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                   color: here > 0 ? '#b91c1c' : '#059669' }}>
                      {fmtGbpDetailed(here)}
                    </span>
                  )}
                  {(c.taxes_owing || 0) > 1 && (
                    <span style={{ fontSize: 10, color: '#c2410c', fontWeight: 600 }}>{c.taxes_owing} taxes</span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ padding: '6px 12px', fontSize: 10.5, color: '#94a3b8', background: '#f8fafc', lineHeight: 1.5 }}>
            Balances shown are {TAX_META[taxKey]?.label || 'this tax'}. The client stays selected as you move
            between {TAX_ORDER.length} tax tabs.
          </div>
        </div>
      )}
    </div>
  );
}
