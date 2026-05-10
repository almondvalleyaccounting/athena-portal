// Shared visual primitives — keep the look consistent across views.

import React from 'react';

export const fontStack = "'Outfit', sans-serif";
export const serifStack = "'Playfair Display', serif";

export const colors = {
  ink: '#0f172a',
  inkSoft: '#475569',
  muted: '#64748b',
  border: '#e5e7eb',
  borderSoft: '#f1f5f9',
  bgSoft: '#f8fafc',
  accent: '#0e7fe0',
  green: '#16a34a',
  amber: '#b45309',
  red: '#b91c1c',
};

export const btnDark = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '8px 14px', fontSize: 13, fontWeight: 600,
  background: colors.ink, color: '#fff', border: 'none', borderRadius: 8,
  cursor: 'pointer', fontFamily: fontStack,
};
export const btnOutline = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '8px 14px', fontSize: 13, fontWeight: 600,
  background: '#fff', color: colors.ink, border: `1px solid ${colors.border}`,
  borderRadius: 8, cursor: 'pointer', fontFamily: fontStack,
};
export const btnGhost = { ...btnOutline, padding: '6px 10px', fontSize: 12 };

export const inputStyle = {
  padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 6,
  fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  width: '100%', boxSizing: 'border-box',
};

export const selectStyle = {
  padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`,
  fontSize: 13, fontFamily: fontStack, background: '#fff', minWidth: 200,
};

export function Pill({ children, color }) {
  return (
    <span style={{
      padding: '4px 10px', fontSize: 11, color: color || colors.inkSoft,
      background: '#f1f5f9', borderRadius: 999, fontWeight: 500,
    }}>{children}</span>
  );
}

export function H2({ children }) {
  return <h2 style={{ fontFamily: serifStack, fontSize: 18, fontWeight: 500, color: colors.ink, margin: '0 0 10px' }}>{children}</h2>;
}

export function Section({ title, right, children }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <H2>{title}</H2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Format pence as £X,XXX or £X.XXm depending on size. */
export function fmtP(p, opts = {}) {
  if (p == null) return '';
  const gbp = p / 100;
  if (opts.compact && Math.abs(gbp) >= 1_000_000) {
    return `£${(gbp / 1_000_000).toFixed(2)}m`;
  }
  if (opts.compact && Math.abs(gbp) >= 1_000) {
    return `£${(gbp / 1_000).toFixed(0)}k`;
  }
  const sign = gbp < 0 ? '-' : '';
  const abs = Math.abs(gbp);
  return sign + '£' + abs.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

export function fmtPct(x, dp = 1) {
  if (x == null) return '';
  return `${x.toFixed(dp)}%`;
}

/** Convert period index to "MMM YY" given the forecast opening date. */
export function periodLabel(period, openingPeriod) {
  if (!openingPeriod) return `t${period}`;
  const d = new Date(openingPeriod);
  const m = new Date(d.getFullYear(), d.getMonth() + period, 1);
  return m.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
}

export function KPI({ label, value, hint, color }) {
  return (
    <div style={{
      padding: 16, background: '#fff', border: `1px solid ${colors.border}`,
      borderRadius: 12, minWidth: 180,
    }}>
      <div style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontFamily: serifStack, fontSize: 24, fontWeight: 500, color: color || colors.ink, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
