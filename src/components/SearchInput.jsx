import React from 'react';

const font = "'Outfit', sans-serif";

// Text input with an inline clear (×) button that appears when the
// field has a value. Use everywhere search/filter inputs live.
export default function SearchInput({ value, onChange, placeholder, style, inputStyle }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '4px 26px 4px 8px',
          fontSize: 12,
          fontFamily: font,
          border: '1px solid #e5e7eb',
          borderRadius: 6,
          background: '#fff',
          color: '#1e293b',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
          ...inputStyle,
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          title="Clear"
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 16,
            height: 16,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
