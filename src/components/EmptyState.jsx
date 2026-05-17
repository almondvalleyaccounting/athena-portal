import React from 'react';

const font = "'Outfit', sans-serif";

// Empty state card used inside lists/tables. Pass:
//   icon    — optional emoji/glyph or lucide element
//   title   — short heading
//   body    — one-line explanation
//   actions — [{ label, onClick, primary? }]
// Centred in a tall padded card so it doesn't look like a missing
// render.
export default function EmptyState({ icon, title, body, actions = [] }) {
  return (
    <div style={{
      padding: '52px 24px', textAlign: 'center', fontFamily: font,
      color: '#475569',
    }}>
      {icon && (
        <div style={{ fontSize: 32, lineHeight: 1, marginBottom: 10, opacity: 0.7 }}>{icon}</div>
      )}
      {title && (
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>{title}</div>
      )}
      {body && (
        <div style={{ fontSize: 13, color: '#64748b', maxWidth: 460, margin: '0 auto 14px' }}>{body}</div>
      )}
      {actions.length > 0 && (
        <div style={{ display: 'inline-flex', gap: 8 }}>
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={a.onClick}
              style={{
                padding: '7px 14px', fontSize: 13, fontWeight: a.primary ? 600 : 500,
                background: a.primary ? '#0f172a' : '#fff',
                color: a.primary ? '#fff' : '#0f172a',
                border: a.primary ? 'none' : '1px solid #e5e7eb',
                borderRadius: 6, cursor: 'pointer', fontFamily: font,
              }}
            >{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
