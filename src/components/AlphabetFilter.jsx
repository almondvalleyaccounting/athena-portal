import React, { useMemo } from 'react';

const ALPHABET = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

// Normalise any name to its first-letter bucket. '#' covers digits, symbols, empty.
export function firstCharBucket(name) {
  const c = (name || '').trim().charAt(0).toUpperCase();
  if (!c) return '#';
  if (/[0-9]/.test(c)) return '#';
  if (/[A-Z]/.test(c)) return c;
  return '#';
}

/**
 * Shared A-Z filter strip.
 *
 * Props:
 *   items        array of rows with a `name` field (or pass nameKey to pick another)
 *   nameKey      field to bucket on (default 'name')
 *   selected     'All' | '#' | 'A'..'Z' | null — null is treated as All
 *   onChange     (letter | null) => void — null means show All
 *   compact      render as a single tight row (default true)
 *
 * Buttons for letters with zero matching items are disabled/greyed. The
 * caller is responsible for filtering `items` by the returned bucket.
 * `firstCharBucket` is exported so the caller can keep bucketing consistent.
 */
export default function AlphabetFilter({ items = [], nameKey = 'name', selected, onChange, compact = true }) {
  const lettersInUse = useMemo(() => {
    const s = new Set();
    for (const it of items) s.add(firstCharBucket(it?.[nameKey]));
    return s;
  }, [items, nameKey]);

  const active = selected || 'All';

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 4,
      padding: compact ? '6px 0' : '10px 0',
      alignItems: 'center',
    }}>
      <button
        type="button"
        onClick={() => onChange(null)}
        style={btn(active === 'All', true)}
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
            onClick={() => onChange(L)}
            style={btn(active === L, enabled)}
          >
            {L}
          </button>
        );
      })}
    </div>
  );
}

function btn(active, enabled) {
  return {
    minWidth: 24, height: 24,
    padding: '0 7px',
    fontSize: 11, fontWeight: active ? 700 : 500,
    fontFamily: "'Outfit', sans-serif",
    border: 'none', borderRadius: 5,
    background: active ? '#0e7fe0' : enabled ? '#f1f5f9' : 'transparent',
    color: active ? '#fff' : enabled ? '#1e293b' : '#cbd5e1',
    cursor: enabled ? 'pointer' : 'default',
    transition: 'background 0.1s',
  };
}
