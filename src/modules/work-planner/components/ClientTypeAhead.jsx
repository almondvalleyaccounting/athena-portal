import React, { useState, useRef, useEffect } from 'react';

export default function ClientTypeAhead({ entityList, value, onChange, onAddNew, size = 'normal' }) {
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

  const selected = value ? entityList.find((e) => e.id === value) : null;
  const hasValue = !!value && !open;

  const filtered = query.trim()
    ? entityList.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
    : entityList;

  const exactMatch = query.trim() && entityList.some(
    (e) => e.name.toLowerCase() === query.trim().toLowerCase()
  );

  const isSmall = size === 'small';

  const inputStyle = isSmall
    ? {
        padding: '2px 6px', fontSize: 10, fontFamily: "'Outfit', sans-serif",
        border: `1px solid ${hasValue ? '#0e7fe0' : '#e5e7eb'}`, borderRadius: 5,
        background: hasValue ? '#eff6ff' : '#fff',
        color: hasValue ? '#0e7fe0' : '#1e293b',
        fontWeight: hasValue ? 600 : 400,
        outline: 'none', width: open ? 140 : 100, transition: 'all 0.15s',
      }
    : {
        padding: '7px 10px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
        border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
        color: '#0f172a', outline: 'none', width: '100%',
      };

  return (
    <div ref={ref} style={{ position: 'relative', display: isSmall ? 'inline-block' : 'block' }}>
      <input
        placeholder={isSmall ? 'Client...' : 'Search clients...'}
        value={open ? query : selected ? selected.name : ''}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        style={inputStyle}
      />
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0,
            minWidth: isSmall ? 180 : '100%', maxHeight: 200, overflowY: 'auto',
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 100, padding: '2px 0',
          }}
        >
          {/* Clear selection */}
          {!isSmall && value && (
            <div
              onClick={() => { onChange(''); setOpen(false); }}
              style={optionStyle(false)}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              <span style={{ color: '#94a3b8' }}>&#8212; None</span>
            </div>
          )}
          {isSmall && (
            <div
              onClick={() => { onChange(''); setOpen(false); }}
              style={optionStyle(!value)}
            >
              All
            </div>
          )}

          {/* Filtered results */}
          {filtered.slice(0, 50).map((entity) => (
            <div
              key={entity.id}
              onClick={() => { onChange(entity.id); setOpen(false); setQuery(''); }}
              style={optionStyle(value === entity.id)}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              {entity.name}
            </div>
          ))}

          {filtered.length === 0 && !query.trim() && (
            <div style={{ padding: '6px 9px', fontSize: 10, color: '#94a3b8' }}>
              No clients found
            </div>
          )}

          {/* Add new option */}
          {query.trim() && !exactMatch && (
            <div
              onClick={async () => {
                const newEntity = await onAddNew(query.trim());
                if (newEntity) {
                  onChange(newEntity.id);
                  setQuery('');
                  setOpen(false);
                }
              }}
              style={{
                padding: '6px 9px', fontSize: 10, cursor: 'pointer',
                color: '#0e7fe0', fontWeight: 600,
                borderTop: '1px solid #f1f5f9',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              + Add &ldquo;{query.trim()}&rdquo;
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function optionStyle(isActive) {
  return {
    padding: '4px 9px', fontSize: 10, cursor: 'pointer',
    color: isActive ? '#0e7fe0' : '#1e293b',
    fontWeight: isActive ? 600 : 400,
    background: isActive ? '#dbeafe' : 'transparent',
  };
}

function hoverIn(e) {
  if (e.currentTarget.style.background !== 'rgb(219, 234, 254)') {
    e.currentTarget.style.background = '#eff6ff';
  }
}
function hoverOut(e) {
  if (e.currentTarget.style.background !== 'rgb(219, 234, 254)') {
    e.currentTarget.style.background = 'transparent';
  }
}
