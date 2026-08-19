import React from 'react';

// Shared vocabulary for Working Papers.
//
// A working paper has a house style that a dashboard does not: figures right-
// aligned and tabular so a column can be eye-added, sources named on every
// line, and a variance shown as a variance rather than dressed up as a status.

export const font = "'Outfit', sans-serif";

export const card = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden',
};

export const th = { padding: '9px 12px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 11.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' };
export const thNum = { ...th, textAlign: 'right' };
export const td = { padding: '7px 12px', color: '#0f172a', fontSize: 13, verticalAlign: 'middle' };
export const tdNum = { ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

export const inputStyle = {
  padding: '6px 9px', fontSize: 12.5, border: '1px solid #e5e7eb',
  borderRadius: 6, fontFamily: font, boxSizing: 'border-box', background: '#fff',
};

export const btn = {
  padding: '6px 13px', fontSize: 12.5, fontWeight: 500, fontFamily: font,
  border: '1px solid #0f172a', borderRadius: 8, background: '#0f172a',
  color: '#fff', cursor: 'pointer',
};

export const btnQuiet = {
  ...btn, border: '1px solid #e5e7eb', background: '#fff', color: '#334155',
};

/**
 * Money, on a working paper's terms.
 *
 * Blank is not zero and must not print as "0.00" — half the point of these
 * papers is telling "this leg says nil" apart from "we have never been told
 * what this leg says". An em dash for the second, a real figure for the first.
 */
export function money(value, { blank = '—' } = {}) {
  if (value === null || value === undefined || value === '') return blank;
  const n = Number(value);
  if (!Number.isFinite(n)) return blank;
  const s = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
}

export function shortDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A tax year label from its start year: 2026 → '2026-27'. */
export function taxYearLabel(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Which tax year a date falls in. 6 April is the boundary, not 1 April and not
 * 31 March, and getting it wrong by five days moves a whole month of CIS.
 */
export function taxYearOf(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const afterSixthApril = d.getUTCMonth() > 3 || (d.getUTCMonth() === 3 && d.getUTCDate() >= 6);
  return taxYearLabel(afterSixthApril ? y : y - 1);
}

export function Pill({ children, colour = '#475569', bg = '#f1f5f9', title }) {
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color: colour, background: bg,
      fontFamily: font, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

/**
 * A variance, judged.
 *
 * Materiality on a control-account reconciliation is not a percentage of
 * turnover — it is whether the difference is explainable. Pence is rounding in
 * a report; pounds is a missing transaction. So the bands are absolute and
 * deliberately tight, and anything over a pound is amber at worst, never green.
 */
export function VarianceCell({ value, tolerance = 0.01 }) {
  if (value === null || value === undefined) {
    return <span style={{ color: '#94a3b8' }}>—</span>;
  }
  const n = Number(value);
  const abs = Math.abs(n);
  const tone = abs <= tolerance ? { c: '#15803d', b: '#f0fdf4' }
    : abs < 1 ? { c: '#a16207', b: '#fefce8' }
    : { c: '#b91c1c', b: '#fef2f2' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 6,
      color: tone.c, background: tone.b, fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
    }}>{money(n)}</span>
  );
}

export function ErrorBar({ message }) {
  if (!message) return null;
  return (
    <div style={{
      ...card, borderColor: '#fecaca', background: '#fef2f2',
      padding: '10px 14px', marginBottom: 12,
    }}>
      <span style={{ fontFamily: font, fontSize: 12.5, color: '#b91c1c' }}>{message}</span>
    </div>
  );
}

/**
 * A leg of a reconciliation that has never been fed.
 *
 * Deliberately loud. A working paper showing a column of dashes where a source
 * should be is the single most dangerous thing in this module if it is quiet
 * about why — a reviewer reads "nil" and ties it to a nil return.
 */
export function NotFedNotice({ leg, why, children }) {
  return (
    <div style={{
      ...card, borderColor: '#ddd6fe', background: '#faf5ff',
      padding: '11px 14px', marginBottom: 12,
    }}>
      <div style={{ fontFamily: font, fontSize: 12.5, color: '#5b21b6', lineHeight: 1.55 }}>
        <strong>{leg} is not fed yet.</strong> {why}{' '}
        Every figure from it reads as unknown, never as nil — so this paper is a
        two-way agreement until it is connected, and cannot be signed off as a
        three-way.
        {children}
      </div>
    </div>
  );
}
