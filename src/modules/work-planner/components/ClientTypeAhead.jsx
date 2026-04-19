import React, { useState, useRef, useEffect, useMemo } from 'react';

const ALPHABET = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

function firstChar(name) {
  const c = (name || '').trim().charAt(0).toUpperCase();
  if (!c) return '#';
  return /[0-9]/.test(c) ? '#' : /[A-Z]/.test(c) ? c : '#';
}

export default function ClientTypeAhead({ entityList, value, onChange, onAddNew, size = 'normal' }) {
  const [query, setQuery] = useState('');
  const [letter, setLetter] = useState(null); // null = all, '#' = digits/symbols, 'A'..'Z'
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Which letters actually have entries — disables empty alphabet buttons.
  const lettersInUse = useMemo(() => {
    const s = new Set();
    for (const e of entityList) s.add(firstChar(e.name));
    return s;
  }, [entityList]);

  const selected = value ? entityList.find((e) => e.id === value) : null;
  const hasValue = !!value && !open;

  const filtered = useMemo(() => {
    let out = entityList;
    if (letter) out = out.filter((e) => firstChar(e.name) === letter);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter((e) => e.name.toLowerCase().includes(q));
    }
    return out;
  }, [entityList, letter, query]);

  const exactMatch = query.trim() && entityList.some(
    (e) => e.name.toLowerCase() === query.trim().toLowerCase()
  );

  const isSmall = size === 'small';

  const inputStyle = isSmall
    ? {
        padding: '3px 8px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
        border: `1px solid ${hasValue ? '#0e7fe0' : '#e5e7eb'}`, borderRadius: 6,
        background: hasValue ? '#eff6ff' : '#fff',
        color: hasValue ? '#0e7fe0' : '#1e293b',
        fontWeight: hasValue ? 600 : 400,
        outline: 'none', width: 130, transition: 'border-color 0.15s, background 0.15s',
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
        onFocus={() => { setOpen(true); setQuery(''); setLetter(null); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        style={inputStyle}
      />
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0,
            minWidth: isSmall ? 260 : '100%',
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 100, padding: '2px 0',
            display: 'flex', flexDirection: 'column', maxHeight: 360,
          }}
        >
          {/* Alphabet jumper — only when no free-text query. */}
          {!query.trim() && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 2,
              padding: '6px 6px 4px',
              borderBottom: '1px solid #f1f5f9',
              flexShrink: 0,
            }}>
              <button
                type="button"
                onClick={(ev) => { ev.preventDefault(); setLetter(null); }}
                style={letterBtn(letter === null, true)}
              >
                All
              </button>
              {ALPHABET.map((L) => {
                const enabled = lettersInUse.has(L);
                return (
                  <button
                    key={L}
                    type="button"
                    disabled={!enabled}
                    onClick={(ev) => { ev.preventDefault(); setLetter(L); }}
                    style={letterBtn(letter === L, enabled)}
                  >
                    {L}
                  </button>
                );
              })}
            </div>
          )}

          {/* Scrollable list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
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

            {/* Filtered results — no hard cap any more (the list scrolls). */}
            {filtered.map((entity) => (
              <div
                key={entity.id}
                onClick={() => { onChange(entity.id); setOpen(false); setQuery(''); setLetter(null); }}
                style={optionStyle(value === entity.id)}
                onMouseEnter={hoverIn}
                onMouseLeave={hoverOut}
              >
                {entity.name}
              </div>
            ))}

            {filtered.length === 0 && !query.trim() && (
              <div style={{ padding: '6px 9px', fontSize: 10, color: '#94a3b8' }}>
                No clients {letter ? `starting with "${letter}"` : 'found'}
              </div>
            )}
          </div>

          {/* Add new option */}
          {query.trim() && !exactMatch && (
            <div
              onClick={async () => {
                try {
                  const newEntity = await onAddNew(query.trim());
                  if (newEntity) {
                    onChange(newEntity.id);
                    setQuery('');
                    setOpen(false);
                  }
                } catch {
                  // Modal handles its own error display
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

function letterBtn(active, enabled) {
  return {
    minWidth: 22, height: 22,
    padding: '0 5px',
    fontSize: 10, fontWeight: active ? 700 : 500,
    fontFamily: "'Outfit', sans-serif",
    border: 'none', borderRadius: 4,
    background: active ? '#0e7fe0' : enabled ? '#f1f5f9' : 'transparent',
    color: active ? '#fff' : enabled ? '#1e293b' : '#cbd5e1',
    cursor: enabled ? 'pointer' : 'default',
    transition: 'background 0.1s',
  };
}
