import React, { useState, useRef, useEffect } from 'react';
import { Filter } from 'lucide-react';

const font = "'Outfit', sans-serif";

// Generic filters popover. Hides a cluster of filter controls behind a
// single button; surfaces a count of active filters on the trigger so
// the user knows when filters are in effect. Closes on outside click
// or Escape.
//
// Pass children — the popover renders them inside a small dropdown.
// Optionally pass `activeCount` to control the badge (defaults to 0).
export default function FiltersPopover({ children, activeCount = 0, label = 'Filters' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', fontSize: 12, fontWeight: 500,
          background: open ? '#f1f5f9' : '#fff',
          color: '#475569', border: '1px solid #e5e7eb',
          borderRadius: 999, cursor: 'pointer', fontFamily: font,
        }}
        title={`${label}${activeCount > 0 ? ` (${activeCount} active)` : ''}`}
      >
        <Filter size={12} />
        <span>{label}</span>
        {activeCount > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
            background: '#0f172a', color: '#fff',
          }}>{activeCount}</span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(15,23,42,0.12)',
          padding: 14, minWidth: 260, fontFamily: font,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}
