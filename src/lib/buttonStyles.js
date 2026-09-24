// One definition of Athena's buttons (UI audit, P3 design sprint).
//
// Three kinds and two sizes, matching the decisions from Sprint 3:
//   primary   — ocean with white text: the one main action on a screen or row
//   secondary — white with a grey border: everything else
//   danger    — white with red text and a red border: destructive, never a fill
// Status colours (green approve, red reject/confirm) are deliberately not
// here — they carry meaning, and stay where they are used.
//
// Most screens style their buttons with inline style objects, so this is the
// shared source for those (spread it: `{ ...BTN.primary.md, width: '100%' }`).
// The <Btn> component in components/ui.jsx renders the same values with
// Tailwind classes so it can have hover states; keep the two in step.

import { brand } from './tokens';

const base = {
  fontFamily: "'Outfit', sans-serif",
  borderRadius: 8,
  cursor: 'pointer',
  lineHeight: 1.25,
};

const sizes = {
  md: { padding: '8px 16px', fontSize: 14 },
  sm: { padding: '5px 10px', fontSize: 13, borderRadius: 6 },
};

const kinds = {
  primary: { background: brand.solid, color: '#fff', border: `1px solid ${brand.solid}`, fontWeight: 600 },
  secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', fontWeight: 500 },
  danger: { background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', fontWeight: 600 },
};

export const BTN = Object.fromEntries(
  Object.entries(kinds).map(([k, v]) => [k, {
    md: { ...base, ...sizes.md, ...v },
    sm: { ...base, ...sizes.sm, ...v },
  }]),
);

export default BTN;
