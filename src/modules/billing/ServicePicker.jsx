import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { Search, ChevronDown, Check } from 'lucide-react';
import { QBO_CATEGORY_ORDER } from './billingServices';

// The service box on a bill line: type to search, grouped under the same
// headings QuickBooks groups its products by (sql/189).
//
// It replaces a plain <select> of 32 names in one alphabetical run, where
// "Business Accounts - Sole Trader" and "Tax Returns - Partnership (SA800)"
// sat five apart with no hint that one is an accounts job and the other a tax
// job. Typing narrows on both the service and its category, so "tax" brings
// back the whole Tax Returns group and "sole" finds the sole trader products
// wherever they live.
//
// The panel is position:fixed and measured off the trigger rather than
// absolutely placed inside it — the bill form is a modal that scrolls
// (overflowY on the overlay), and an absolutely-positioned panel would be
// clipped by it on the lower lines. Hence the reposition-on-scroll.

// Space the panel wants below the trigger before it gives up and opens
// upwards, and how wide it goes regardless of how narrow the column is.
const PANEL_MAX_HEIGHT = 320;
const PANEL_MIN_WIDTH = 340;

export default function ServicePicker({ value, options, onChange, style, disabled, placeholder = 'Select...' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const hiRef = useRef(null);

  const selected = options.find((o) => o.id === value) || null;
  // A service the line already carries that isn't in the list — copied off a
  // QBO invoice, or mapped since the bill was drafted. Shown as-is so editing
  // an old bill can't silently blank its line.
  const unmapped = !!value && !selected;
  const display = selected ? selected.label : (value || '');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? options.filter((o) => `${o.category || ''} ${o.label}`.toLowerCase().includes(q))
      : options;
    const byCat = new Map();
    for (const o of hits) {
      const cat = o.category || 'Uncategorised';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(o);
    }
    // Known categories in the order the firm thinks about them; anything new in
    // QBO falls in alphabetically after, rather than disappearing.
    const known = QBO_CATEGORY_ORDER.filter((c) => byCat.has(c));
    const rest = [...byCat.keys()].filter((c) => !QBO_CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...known, ...rest].map((cat) => ({
      cat,
      items: byCat.get(cat).sort((a, b) => a.label.localeCompare(b.label)),
    }));
  }, [options, query]);

  // Flat order for the arrow keys — the headings aren't stops.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => { setHi(0); }, [query]);

  // Measure the trigger, and keep the panel with it while the modal scrolls.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => { const r = wrapRef.current?.getBoundingClientRect(); if (r) setRect(r); };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => { hiRef.current?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);

  const pick = (opt) => { onChange(opt.id); setOpen(false); setQuery(''); inputRef.current?.blur(); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHi((i) => Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), flat.length - 1));
    } else if (e.key === 'Enter') {
      if (open && flat[hi]) { e.preventDefault(); pick(flat[hi]); }
    } else if (e.key === 'Escape') {
      // Only ever closes the picker. Without this the form's own Escape
      // handler would take it as "close the bill" and throw away the edit.
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // Below the trigger, unless there isn't room and there's more above.
  const below = rect ? window.innerHeight - rect.bottom - 8 : 0;
  const above = rect ? rect.top - 8 : 0;
  const dropUp = rect ? below < 220 && above > below : false;
  const panelStyle = rect ? {
    position: 'fixed',
    left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, PANEL_MIN_WIDTH) - 8)),
    width: Math.max(rect.width, PANEL_MIN_WIDTH),
    ...(dropUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    maxHeight: Math.min(PANEL_MAX_HEIGHT, dropUp ? above : below),
  } : { display: 'none' };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          value={open ? query : display}
          placeholder={placeholder}
          disabled={disabled}
          title={selected?.category ? `${selected.category} › ${selected.label}` : (unmapped ? `${value} — not mapped to a QuickBooks product` : undefined)}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onMouseDown={() => { if (!open) { setOpen(true); setQuery(''); } }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
          style={{
            ...style,
            paddingRight: 26,
            cursor: disabled ? 'not-allowed' : 'text',
            color: unmapped && !open ? '#b45309' : style?.color,
            textOverflow: 'ellipsis',
          }}
        />
        <ChevronDown
          size={14}
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }}
        />
      </div>

      {open && (
        <div ref={panelRef} style={{ ...panelStyle, zIndex: 1200, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.14)', overflowY: 'auto', fontFamily: "'Outfit', sans-serif" }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: '1px solid #f1f5f9', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
            <Search size={12} style={{ color: '#94a3b8', flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {query ? `${flat.length} match${flat.length === 1 ? '' : 'es'}` : `${flat.length} services, grouped as in QuickBooks`}
            </span>
          </div>

          {flat.length === 0 && (
            <div style={{ padding: '12px 12px', fontSize: 12, color: '#94a3b8' }}>
              Nothing matches “{query}”. Only services mapped to a QuickBooks product can be billed.
            </div>
          )}

          {groups.map((g) => (
            <div key={g.cat}>
              <div style={{ padding: '6px 10px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', background: '#fbfcfd' }}>
                {g.cat}
              </div>
              {g.items.map((o) => {
                const idx = flat.indexOf(o);
                const active = idx === hi;
                const isSel = o.id === value;
                return (
                  <div
                    key={o.id}
                    ref={active ? hiRef : null}
                    onMouseEnter={() => setHi(idx)}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 10px 6px 14px', fontSize: 13, cursor: 'pointer',
                      background: active ? '#eff6ff' : 'transparent',
                      color: isSel ? '#0e7fe0' : '#1e293b',
                      fontWeight: isSel ? 600 : 400,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                    {isSel && <Check size={13} style={{ flexShrink: 0 }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
