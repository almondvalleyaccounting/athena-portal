import React, { useEffect, useState } from 'react';

// Shared vocabulary and small primitives for the HMRC module.

export const font = "'Outfit', sans-serif";

// Chase tiers come from v_hmrc_paye_clients. The split that matters
// operationally is not size of debt but whether the scheme has stopped paying:
// arrears carried from an earlier tax year is a structurally different problem
// from being a month behind, and a scheme on an HMRC payment plan is already
// being handled.
export const TIERS = {
  1: { label: 'In arrears',        short: 'Arrears',      colour: '#b91c1c', bg: '#fef2f2', hint: 'Owes from an earlier tax year and is not on a payment plan — the ones to chase' },
  2: { label: 'Behind this year',  short: 'Behind',       colour: '#c2410c', bg: '#fff7ed', hint: 'Owes only against the current tax year' },
  3: { label: 'On a payment plan', short: 'Plan',         colour: '#0369a1', bg: '#f0f9ff', hint: 'HMRC has a time-to-pay arrangement in place — monitor, do not chase' },
  4: { label: 'Clear',             short: 'Clear',        colour: '#059669', bg: '#f0fdf4', hint: 'Nothing owed at the last scrape' },
};

export const REVIEW_STATUSES = [
  { value: 'pending',         label: 'Not looked at', colour: '#f59e0b', bg: '#fffbeb' },
  { value: 'chasing',         label: 'Chasing',       colour: '#b91c1c', bg: '#fef2f2' },
  { value: 'awaiting_client', label: 'With client',   colour: '#7c3aed', bg: '#faf5ff' },
  { value: 'plan_agreed',     label: 'Plan agreed',   colour: '#0369a1', bg: '#f0f9ff' },
  { value: 'resolved',        label: 'Resolved',      colour: '#059669', bg: '#f0fdf4' },
  { value: 'ignore',          label: 'Not ours',      colour: '#94a3b8', bg: '#f8fafc' },
];

export const STANDINGS = {
  client:        { label: 'Client',        colour: '#059669' },
  former_client: { label: 'Former client', colour: '#c2410c' },
  not_a_client:  { label: 'Not in Athena', colour: '#b91c1c' },
  unclear:       { label: 'Unclear',       colour: '#94a3b8' },
};

// The scraper's own words for why a scheme landed on the authorisation list.
export const DISENGAGE_REASONS = {
  no_athena_record: 'No Athena record at all',
  archived:         'Athena record is archived',
  nlac:             'Marked no longer a client',
};

export const EXCEPTION_KINDS = {
  missing_in_athena: {
    label: 'On HMRC, not in Athena',
    hint: 'HMRC lists us as agent for this scheme but no Athena entity carries the reference or the name. Either the client is missing, or the PAYE ref was never keyed in.',
    colour: '#b91c1c',
  },
  not_on_hmrc: {
    label: 'In Athena, not on HMRC',
    hint: 'Athena holds a PAYE reference that did not appear on the agent list — usually authorisation was never set up, or it has lapsed.',
    colour: '#c2410c',
  },
  duplicate_ref: {
    label: 'Duplicate reference',
    hint: 'The same PAYE reference is on more than one Athena entity. One of them is wrong.',
    colour: '#7c3aed',
  },
  second_scheme: {
    label: 'Second scheme',
    hint: 'The client runs more than one PAYE scheme. Usually fine — confirm it is deliberate.',
    colour: '#0369a1',
  },
  format: {
    label: 'Reference format',
    hint: 'The stored reference is not a valid district/reference pair, so it can never match.',
    colour: '#0891b2',
  },
  blank_ref: {
    label: 'Blank reference',
    hint: 'Athena has an empty PAYE reference where one was expected.',
    colour: '#64748b',
  },
};

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

// "2 yr 4 mo" reads better than "778 days" when the point is how stale arrears
// have become.
export function ageLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${years} yr ${rem} mo` : `${years} yr`;
}

export function Pill({ children, colour, bg, title, style }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 11, fontWeight: 600, color: colour,
        background: bg || `${colour}12`,
        border: `1px solid ${colour}33`,
        borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
        display: 'inline-block', ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, colour, hint, big }) {
  return (
    <div
      title={hint || ''}
      style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${colour}` }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 19, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: '#cbd5e1', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export function Chip({ value, label, active, onClick, count, colour }) {
  const isActive = active === value;
  return (
    <button
      onClick={() => onClick(value)}
      style={{
        padding: '6px 12px', fontSize: 12, fontWeight: isActive ? 600 : 500,
        color: isActive ? (colour || '#0f172a') : '#64748b',
        background: isActive ? '#f1f5f9' : '#fff',
        border: `1px solid ${isActive ? (colour ? `${colour}55` : '#cbd5e1') : '#e5e7eb'}`,
        borderRadius: 999, cursor: 'pointer', fontFamily: font, whiteSpace: 'nowrap',
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{ marginLeft: 6, fontSize: 11, color: isActive ? '#64748b' : '#94a3b8' }}>{count}</span>
      )}
    </button>
  );
}

// Saves on blur rather than per keystroke — every one of these writes to the
// database.
export function BlurInput({ value, onChange, placeholder, style }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || '')) onChange(v); }}
      style={{ ...inputStyle, ...style }}
    />
  );
}

export function ErrorBar({ message }) {
  if (!message) return null;
  return (
    <div style={{
      background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
      borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12,
    }}>
      {message}
    </div>
  );
}

export const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' };
export const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
export const thNum = { ...th, textAlign: 'right' };
export const tdNum = { ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
export const inputStyle = {
  width: '100%', padding: '6px 9px', fontSize: 12, border: '1px solid #e5e7eb',
  borderRadius: 6, fontFamily: font, boxSizing: 'border-box', background: '#fff',
};
export const card = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden',
};

// ── the four tax heads, in one place ───────────────────────────────
// Slug, label and colour were repeated in four files and had already drifted
// ("Self Assmt" here, "Self Assessment" there). The slug is also the route
// segment and the key v_hmrc_client_tax_summary uses, so the map is the single
// definition of what a tax head IS in this module.
export const TAX_META = {
  'paye':            { label: 'PAYE',             short: 'PAYE',       colour: '#0e7fe0', totalsKey: 'paye' },
  'corporation-tax': { label: 'Corporation Tax',  short: 'Corp Tax',   colour: '#7c3aed', totalsKey: 'corporation_tax' },
  'vat':             { label: 'VAT',              short: 'VAT',        colour: '#c2410c', totalsKey: 'vat' },
  'self-assessment': { label: 'Self Assessment',  short: 'Self Assmt', colour: '#0369a1', totalsKey: 'self_assessment' },
};

export const TAX_ORDER = ['paye', 'corporation-tax', 'vat', 'self-assessment'];

// What each level of the module means, so the same words are used on every tab.
//
//   0  All taxes — every client, one number per tax head
//   1  one client, one tax — how that number is made up
//   2  the transactions under a single figure at level 1
//
// Level 0 links into level 1; a figure at level 1 opens level 2 beneath it.
export const LEVELS = {
  0: { label: 'Level 0', hint: 'Every client, one figure per tax' },
  1: { label: 'Level 1', hint: 'One client, one tax — what the figure is made of' },
  2: { label: 'Level 2', hint: 'The individual transactions behind a figure' },
};

// The trail back up. Rendered on every tax tab so it is always obvious which of
// the three levels you are reading and how to get back to the one above.
export function LevelTrail({ level, taxKey, clientName, onLevel0, onLevel1, onClearClient }) {
  const meta = TAX_META[taxKey];
  const crumb = (label, onClick, active) => (
    <button
      onClick={onClick}
      disabled={!onClick || active}
      style={{
        background: 'none', border: 'none', padding: 0, fontFamily: font, fontSize: 11.5,
        color: active ? '#0f172a' : (onClick ? '#0e7fe0' : '#94a3b8'),
        fontWeight: active ? 600 : 500,
        cursor: onClick && !active ? 'pointer' : 'default',
      }}
    >
      {label}
    </button>
  );
  const sep = <span style={{ color: '#cbd5e1', fontSize: 11 }}>›</span>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 10 }}>
      {crumb('All taxes', onLevel0, level === 0)}
      {sep}
      {crumb(
        clientName ? `${meta?.label || taxKey} · ${clientName}` : meta?.label || taxKey,
        level > 1 ? onLevel1 : null,
        level === 1,
      )}
      {level >= 2 && <>{sep}{crumb('Transactions', null, true)}</>}
      <span
        title={LEVELS[level]?.hint}
        style={{
          fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
          color: '#94a3b8', background: '#f1f5f9', border: '1px solid #e5e7eb',
          borderRadius: 999, padding: '1px 7px', marginLeft: 2,
        }}
      >
        {LEVELS[level]?.label}
      </span>
      {clientName && onClearClient && (
        <button
          onClick={onClearClient}
          style={{
            marginLeft: 'auto', background: 'none', border: 'none', padding: 0,
            fontFamily: font, fontSize: 11, color: '#b91c1c', cursor: 'pointer',
          }}
        >
          every client on this tax
        </button>
      )}
    </div>
  );
}
