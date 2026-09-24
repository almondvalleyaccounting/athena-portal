import React from 'react';

// Marks a module Bobby has said is only partly built, so the team can tell
// what to rely on. `short` is for the sidebar, where "In development" doesn't
// fit beside the longer labels.
export default function InDevelopmentTag({ short = false }) {
  return (
    <span
      title="In development — still being built. Check figures before relying on them."
      style={{
        fontFamily: "'Outfit', sans-serif",
        fontSize: short ? 10.5 : 11,
        fontWeight: 600,
        lineHeight: short ? '14px' : '16px',
        display: 'inline-block',
        color: '#92400e',
        backgroundColor: '#fef3c7',
        border: '1px solid #fde68a',
        padding: short ? '0 5px' : '0 6px',
        borderRadius: 8,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {short ? 'In dev' : 'In development'}
    </span>
  );
}
