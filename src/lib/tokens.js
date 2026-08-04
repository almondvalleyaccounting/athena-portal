// Semantic palette for Athena UI.
//
// 4 semantic tones + 2 modifier tones:
//   success — green   : approved, positive delta
//   warning — amber   : suggested, staged, needs review
//   danger  — red     : rejected, NLAC, duplicates, destructive
//   info    — sky     : neutral interactive, focus, QBO template
//   accent  — purple  : uplift / pending changes (anything in the
//                       "future fee book" flow)
//   teal    — cyan    : email labels/tags and machine suggestions — a cool
//                       tone that reads as "the system proposes" without the
//                       alarm of amber or the fee-book meaning of purple.
//                       Deliberately blue-leaning (cyan, not green-teal) so it
//                       sits beside info rather than reading as a success green
//   neutral — slate   : muted text, all, archived, off-state
//
// Each tone exposes:
//   bg     — soft background for chips/tiles
//   fg     — foreground colour for text on bg
//   border — solid edge for outlined elements
//   solid  — strong fill for filled buttons
//   onSolid — text colour for filled buttons (usually white)
//
// Use the helpers (chip / pill / etc) below rather than the raw
// numbers when possible — they keep us consistent over time.

export const tones = {
  success: { bg: '#dcfce7', fg: '#166534', border: '#86efac', solid: '#059669', onSolid: '#fff' },
  warning: { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d', solid: '#d97706', onSolid: '#fff' },
  danger:  { bg: '#fee2e2', fg: '#b91c1c', border: '#fca5a5', solid: '#b91c1c', onSolid: '#fff' },
  info:    { bg: '#dbeafe', fg: '#0c4a6e', border: '#93c5fd', solid: '#0e7fe0', onSolid: '#fff' },
  accent:  { bg: '#ede9fe', fg: '#5b21b6', border: '#c4b5fd', solid: '#7c3aed', onSolid: '#fff' },
  teal:    { bg: '#cffafe', fg: '#155e75', border: '#67e8f9', solid: '#0891b2', onSolid: '#fff' },
  neutral: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1', solid: '#0f172a', onSolid: '#fff' },
};

// Build a chip style — small rounded label with bg + fg.
export function chipStyle(tone) {
  const t = tones[tone] || tones.neutral;
  return {
    display: 'inline-block',
    fontSize: 10, fontWeight: 700,
    padding: '2px 8px', borderRadius: 999,
    background: t.bg, color: t.fg,
  };
}

// Build an outlined pill (for tab-like filter pills).
export function pillStyle({ tone, active }) {
  const t = tones[tone] || tones.neutral;
  return {
    fontSize: 12, fontWeight: active ? 600 : 500,
    padding: '5px 12px', borderRadius: 999,
    background: active ? t.bg : '#fff',
    color: t.fg,
    border: `1px solid ${t.border}`,
    cursor: 'pointer',
  };
}
