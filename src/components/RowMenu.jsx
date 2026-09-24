import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

const font = "'Outfit', sans-serif";

/*
  The "⋮" menu for a list row (UI audit, Sprint 4: one main action per row).
  The row shows its one obvious next step as a button; everything else lives
  here, with destructive items last, in red, split off by a rule.

  items: [{ label, icon?: LucideIcon, onClick, danger?, title? }] — pass only
  the items that apply to this row. Opens with position: fixed so a table
  cell's overflow can't clip it, and closes on an outside click, Escape or
  scroll.
*/
export default function RowMenu({ items, compact = false, label = 'More actions' }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const esc = (e) => { if (e.key === 'Escape') setPos(null); };
    const gone = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
    };
  }, [pos]);

  if (!items || items.length === 0) return null;
  const safe = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    const width = 210;
    const est = (items.length * 36) + (danger.length && safe.length ? 9 : 0) + 12;
    const below = r.bottom + 4 + est < window.innerHeight;
    setPos({ left: Math.max(8, r.right - width), top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - est), width });
  };

  const run = (item) => { setPos(null); item.onClick(); };
  const itemStyle = (d) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '8px 10px', fontSize: 14, border: 'none', borderRadius: 8, background: 'none',
    color: d ? '#b91c1c' : '#0f172a', cursor: 'pointer', fontFamily: font,
  });
  const renderItem = (item) => {
    const Icon = item.icon;
    return (
      <button
        key={item.label} role="menuitem" title={item.title} onClick={() => run(item)} style={itemStyle(item.danger)}
        onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? '#fef2f2' : '#f1f5f9'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        {Icon && <Icon size={15} style={{ color: item.danger ? '#b91c1c' : '#64748b', flexShrink: 0 }} />}
        {item.label}
      </button>
    );
  };

  const size = compact ? 24 : 30;
  return (
    <>
      <button
        ref={btnRef} onClick={toggle} aria-label={label} aria-haspopup="menu" aria-expanded={!!pos} title={label}
        style={{
          width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid ' + (pos ? '#94a3b8' : '#e5e7eb'), borderRadius: 8, background: '#fff', color: '#475569', cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
      >
        <MoreVertical size={compact ? 14 : 16} />
      </button>
      {pos && (
        <div
          ref={menuRef} role="menu"
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 60, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: 6 }}
        >
          {safe.map(renderItem)}
          {safe.length > 0 && danger.length > 0 && <div style={{ borderTop: '1px solid #f1f5f9', margin: '4px 0' }} />}
          {danger.map(renderItem)}
        </div>
      )}
    </>
  );
}
