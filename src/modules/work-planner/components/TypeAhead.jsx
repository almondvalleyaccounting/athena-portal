import React, { useState, useRef, useEffect } from 'react';

export default function TypeAhead({ items, value, onChange, placeholder = 'All' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = items.filter(
    (it) => it.label.toLowerCase().includes(query.toLowerCase())
  );
  const selected = value ? items.find((it) => it.id === value) : null;

  const hasValue = !!value && !open;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <input
        placeholder={placeholder}
        value={open ? query : selected ? selected.label : ''}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        style={{
          padding: '3px 8px',
          fontSize: 12,
          fontFamily: "'Outfit', sans-serif",
          border: `1px solid ${hasValue ? '#0e7fe0' : '#e5e7eb'}`,
          borderRadius: 6,
          background: hasValue ? '#eff6ff' : '#fff',
          color: hasValue ? '#0e7fe0' : '#1e293b',
          fontWeight: hasValue ? 600 : 400,
          outline: 'none',
          width: 120,
          transition: 'border-color 0.15s, background 0.15s',
        }}
      />
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            minWidth: 150,
            maxHeight: 180,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: 100,
            padding: '2px 0',
          }}
        >
          <div
            onClick={() => { onChange(''); setOpen(false); }}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
              color: !value ? '#0e7fe0' : '#1e293b',
              fontWeight: !value ? 600 : 400,
              background: !value ? '#dbeafe' : 'transparent',
            }}
          >
            All
          </div>
          {filtered.map((it) => (
            <div
              key={it.id}
              onClick={() => { onChange(it.id); setOpen(false); }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                cursor: 'pointer',
                color: value === it.id ? '#0e7fe0' : '#1e293b',
                fontWeight: value === it.id ? 600 : 400,
                background: value === it.id ? '#dbeafe' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (value !== it.id) e.currentTarget.style.background = '#eff6ff';
              }}
              onMouseLeave={(e) => {
                if (value !== it.id) e.currentTarget.style.background = 'transparent';
              }}
            >
              {it.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
