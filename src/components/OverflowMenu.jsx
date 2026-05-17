import React, { useState, useRef, useEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';

const font = "'Outfit', sans-serif";

// Three-dot overflow menu. Pass `items` as an array of
//   { label, icon?, onClick, danger?, disabled? }
// Renders a compact button; clicking opens a small menu next to it.
// Closes on outside click, Escape, or any item click.
export default function OverflowMenu({ items, size = 24 }) {
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

  if (!items || items.length === 0) return null;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="More actions"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, padding: 0,
          background: open ? '#f1f5f9' : '#fff',
          border: '1px solid #e5e7eb40', borderRadius: 6,
          color: '#64748b', cursor: 'pointer',
        }}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 40,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          boxShadow: '0 10px 30px rgba(15,23,42,0.12)',
          padding: 4, minWidth: 200, fontFamily: font,
        }}>
          {items.map((it, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick?.(); }}
              disabled={it.disabled}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', textAlign: 'left',
                padding: '7px 10px', fontSize: 12, fontWeight: 500,
                background: 'transparent', border: 'none', borderRadius: 6,
                color: it.disabled ? '#cbd5e1' : (it.danger ? '#b91c1c' : '#1e293b'),
                cursor: it.disabled ? 'not-allowed' : 'pointer',
                fontFamily: font,
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = '#f8fafc'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {it.icon && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{it.icon}</span>}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
