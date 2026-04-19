import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Zap } from 'lucide-react';

const font = "'Outfit', sans-serif";

// Mock data covering every row state so each theme can be compared apples-to-apples.
const MOCK_ROWS = [
  { id: '867',  name: '101 Business Solutions Ltd',       state: 'unmapped',   sugg: { name: '101 Business Solutions Ltd', score: 1.00 }, sel: false },
  { id: '784',  name: '191 Architecture Ltd',              state: 'unmapped',   sugg: { name: '191 Architecture Ltd',      score: 1.00 }, sel: true  },
  { id: '749',  name: 'A & M Investments (Aberdeen) Ltd',  state: 'unmapped',   sugg: { name: 'A & M Investments (Aberdeen) Limited', score: 0.97 }, sel: false },
  { id: '253',  name: 'Adrian Wilson',                     state: 'unmapped',   sugg: { name: 'Wilson, Adrian',             score: 0.58 }, sel: false },
  { id: '944',  name: 'Agn Developments Ltd_1',            state: 'unmapped',   sugg: { name: 'Agn Developments Ltd',       score: 0.91 }, sel: false },
  { id: '828',  name: '20 for £60_20052920_ESS_15',        state: 'unmapped',   sugg: null,                                                sel: false },
  { id: '201',  name: 'Cloudbreak Capital Ltd',            state: 'mapped',     sugg: null,                                                sel: false, entity: 'Cloudbreak Capital Ltd' },
  { id: '914',  name: '20 for £60_ASSIGNED_to_Acme',       state: 'review',     prev: '20 for £60_20052920_ESS_18', sugg: null,           sel: false },
  { id: '777',  name: '20 for £60_UNUSED',                 state: 'ignored',    sugg: null,                                                sel: false },
];

/* ============================================================
 * Theme definitions — every color token each row / chip needs.
 * ============================================================ */
const THEMES = {
  A: {
    label: 'A · Minimal',
    caption: 'Near-monochrome. Portal ocean-blue is the only accent. Row meaning via left hairlines.',
    page: '#ffffff',
    table: '#ffffff',
    header: '#f8fafc',
    rowDefault:   { bg: '#ffffff', border: 'transparent' },
    rowUnmapped:  { bg: '#ffffff', border: '#fcd34d' },         // 3px amber left hairline
    rowMapped:    { bg: '#ffffff', border: 'transparent' },
    rowReview:    { bg: '#eef2ff', border: '#818cf8' },
    rowIgnored:   { bg: '#ffffff', border: 'transparent', opacity: 0.55 },
    rowSelected:  { bg: '#f0f9ff', border: '#38bdf8' },
    chipStrong:   { bg: '#e0f2fe', fg: '#0c4a6e', border: '#38bdf8' },  // high-confidence: blue ring
    chipSoft:     { bg: '#f1f5f9', fg: '#0c4a6e', border: '#e2e8f0' },
    pillUnmapped: { bg: '#fff', fg: '#78350f', border: '#fcd34d', active: { bg: '#fef3c7', fg: '#78350f' } },
    pillMapped:   { bg: '#fff', fg: '#0c4a6e', border: '#93c5fd', active: { bg: '#dbeafe', fg: '#1e40af' } },
    pillReview:   { bg: '#fff', fg: '#3730a3', border: '#c7d2fe', active: { bg: '#eef2ff', fg: '#3730a3' } },
    pillIgnored:  { bg: '#fff', fg: '#64748b', border: '#cbd5e1', active: { bg: '#f1f5f9', fg: '#475569' } },
    banner: { bg: '#f0f9ff', border: '#bae6fd', fg: '#0c4a6e' },
  },

  B: {
    label: 'B · Warm paper',
    caption: 'Cream base, navy text, teal + coral accents. No green traffic-light.',
    page: '#fafaf7',
    table: '#ffffff',
    header: '#f5f4ef',
    rowDefault:   { bg: '#ffffff' },
    rowUnmapped:  { bg: '#fdf8f3' },
    rowMapped:    { bg: '#ffffff' },
    rowReview:    { bg: '#fff1ed' },
    rowIgnored:   { bg: '#faf9f5', opacity: 0.65 },
    rowSelected:  { bg: '#eef4fb' },
    chipStrong:   { bg: '#0f766e', fg: '#ffffff', border: '#0f766e' },  // filled teal
    chipSoft:     { bg: '#f5f5f4', fg: '#0f766e', border: '#e7e5e4' },
    pillUnmapped: { bg: '#fff', fg: '#9a3412', border: '#fdba74', active: { bg: '#ffedd5', fg: '#7c2d12' } },
    pillMapped:   { bg: '#fff', fg: '#0f766e', border: '#99f6e4', active: { bg: '#ccfbf1', fg: '#115e59' } },
    pillReview:   { bg: '#fff', fg: '#9f1239', border: '#fecdd3', active: { bg: '#ffe4e6', fg: '#881337' } },
    pillIgnored:  { bg: '#fff', fg: '#6b7280', border: '#d6d3d1', active: { bg: '#f5f5f4', fg: '#57534e' } },
    banner: { bg: '#f0fdfa', border: '#99f6e4', fg: '#115e59' },
  },

  C: {
    label: 'C · Desaturated semantic',
    caption: 'Same meaning as today but drained of saturation. Closest to current — least disruptive.',
    page: '#ffffff',
    table: '#ffffff',
    header: '#f8fafc',
    rowDefault:   { bg: '#ffffff' },
    rowUnmapped:  { bg: '#fef7ed' },  // soft peach instead of acid yellow
    rowMapped:    { bg: '#ffffff' },  // no green fill
    rowReview:    { bg: '#f5f3ff' },  // lavender
    rowIgnored:   { bg: '#f8fafc', opacity: 0.6 },
    rowSelected:  { bg: '#eff6ff' },
    chipStrong:   { bg: '#ecfdf5', fg: '#166534', border: '#86efac' },  // sage
    chipSoft:     { bg: '#f1f5f9', fg: '#334155', border: '#e2e8f0' },  // steel
    pillUnmapped: { bg: '#fff', fg: '#9a3412', border: '#fdba74', active: { bg: '#fef7ed', fg: '#9a3412' } },
    pillMapped:   { bg: '#fff', fg: '#166534', border: '#bbf7d0', active: { bg: '#ecfdf5', fg: '#166534' } },
    pillReview:   { bg: '#fff', fg: '#6b21a8', border: '#d8b4fe', active: { bg: '#f5f3ff', fg: '#6b21a8' } },
    pillIgnored:  { bg: '#fff', fg: '#64748b', border: '#cbd5e1', active: { bg: '#f1f5f9', fg: '#475569' } },
    banner: { bg: '#f0f9ff', border: '#bae6fd', fg: '#0c4a6e' },
  },
};

export default function ThemePreview() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <button
        onClick={() => navigate('/billing/qbo-mapping')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 12, fontWeight: 500, color: '#64748b',
          background: 'none', border: 'none', cursor: 'pointer',
          marginBottom: 12, padding: 0, fontFamily: font,
        }}
      >
        <ArrowLeft size={14} /> Back to QBO mapping
      </button>

      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 6 }}>
        QBO mapping · theme preview
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24, maxWidth: 800 }}>
        Three options rendered against the same mock data. Pick A, B, or C (or say which
        elements from each to mix) and the whole mapping page plus the Fee Billing QBO
        panel will switch to match.
      </p>

      {Object.entries(THEMES).map(([key, theme]) => (
        <ThemeBlock key={key} theme={theme} />
      ))}
    </div>
  );
}

function ThemeBlock({ theme }) {
  return (
    <div style={{
      marginBottom: 40, padding: 20, borderRadius: 12,
      background: theme.page, border: '1px solid #e5e7eb',
    }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>
        {theme.label}
      </h2>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>{theme.caption}</p>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Pill theme={theme} tone="review" count={1} active>Needs review</Pill>
        <Pill theme={theme} tone="unmapped" count={6}>Unmapped</Pill>
        <Pill theme={theme} tone="mapped" count={1}>Mapped</Pill>
        <Pill theme={theme} tone="ignored" count={1}>Ignored</Pill>
      </div>

      {/* Auto-accept banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', marginBottom: 14,
        background: theme.banner.bg, border: `1px solid ${theme.banner.border}`,
        borderRadius: 8, color: theme.banner.fg,
      }}>
        <Zap size={14} />
        <span style={{ fontSize: 13, flex: 1 }}>
          <b>4</b> unmapped QBO customer(s) have a <b>90%+</b> name match to an Athena entity.
        </span>
        <button style={{
          padding: '7px 14px', fontSize: 12, fontWeight: 600,
          background: theme.banner.fg, color: '#fff',
          border: 'none', borderRadius: 6, cursor: 'pointer',
        }}>Auto-accept all 4</button>
      </div>

      {/* Sample table */}
      <div style={{ background: theme.table, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 32 }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '27%' }} />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr style={{ background: theme.header }}>
              <Th><input type="checkbox" readOnly /></Th>
              <Th>QBO customer</Th>
              <Th>Suggested match</Th>
              <Th>Athena entity</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {MOCK_ROWS.map((r) => (
              <Row key={r.id} row={r} theme={theme} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ row, theme }) {
  const tone =
    row.state === 'review'   ? theme.rowReview :
    row.state === 'ignored'  ? theme.rowIgnored :
    row.state === 'mapped'   ? theme.rowMapped :
    row.state === 'unmapped' ? theme.rowUnmapped : theme.rowDefault;
  const sel = row.sel ? theme.rowSelected : null;
  const bg = sel?.bg || tone.bg;
  const border = tone.border ? `3px solid ${tone.border}` : (sel?.border ? `3px solid ${sel.border}` : undefined);
  const opacity = tone.opacity != null ? tone.opacity : 1;

  return (
    <tr style={{
      borderTop: '1px solid #f1f5f9',
      background: bg,
      opacity,
      borderLeft: border,
    }}>
      <Td><input type="checkbox" readOnly checked={row.sel} /></Td>
      <Td>
        <div style={{ fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={row.name}>{row.name}</div>
        {row.state === 'review' && row.prev && (
          <div style={{
            fontSize: 10, marginTop: 2, display: 'inline-block',
            padding: '1px 6px', borderRadius: 4,
            background: theme.rowReview.bg === '#fff1ed' ? '#ffe4e6' : '#ede9fe',
            color: theme.rowReview.bg === '#fff1ed' ? '#9f1239' : '#6b21a8',
            border: '1px solid ' + (theme.rowReview.bg === '#fff1ed' ? '#fecdd3' : '#d8b4fe'),
          }}>renamed — was: {row.prev}</div>
        )}
        <div style={{ fontFamily: 'monospace', color: '#94a3b8', fontSize: 10 }}>QBO #{row.id}</div>
      </Td>
      <Td>
        {row.sugg ? (
          <SuggestionChip theme={theme} score={row.sugg.score} name={row.sugg.name} />
        ) : row.state === 'unmapped' ? (
          <span style={{ fontSize: 10, color: '#94a3b8' }}>No close match</span>
        ) : <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>}
      </Td>
      <Td>
        <div style={{
          padding: '3px 8px', fontSize: 12, border: '1px solid #e5e7eb',
          borderRadius: 6, background: '#fff', color: row.entity ? '#0f172a' : '#94a3b8',
          fontWeight: row.entity ? 500 : 400,
        }}>
          {row.entity || 'Client...'}
        </div>
      </Td>
      <Td>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6,
            border: '1px solid #fca5a5', background: '#fff', color: '#991b1b',
            cursor: 'pointer', fontFamily: font,
          }}>Ignore</button>
          <span style={{ color: '#cbd5e1', fontSize: 14, padding: '0 4px' }}>✕</span>
        </div>
      </Td>
    </tr>
  );
}

function SuggestionChip({ theme, score, name }) {
  const strong = score >= 0.9;
  const t = strong ? theme.chipStrong : theme.chipSoft;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 11, padding: '3px 8px', borderRadius: 999,
      background: t.bg, color: t.fg,
      border: `1px solid ${t.border}`,
      fontFamily: font, fontWeight: 500,
    }}>
      <Check size={10} /> {name}
      <span style={{ color: strong ? (t.fg === '#ffffff' ? '#bae6fd' : '#64748b') : '#64748b', fontWeight: 400 }}> · {Math.round(score * 100)}%</span>
    </span>
  );
}

function Pill({ theme, tone, count, active, children }) {
  const def = {
    unmapped: theme.pillUnmapped,
    mapped:   theme.pillMapped,
    review:   theme.pillReview,
    ignored:  theme.pillIgnored,
  }[tone];
  const s = active ? def.active : { bg: def.bg, fg: def.fg };
  return (
    <button style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: s.bg, color: s.fg, border: `1px solid ${def.border}`,
      cursor: 'pointer', fontFamily: font,
    }}>
      {children} · {count}
    </button>
  );
}

const Th = ({ children }) => (
  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </th>
);
const Td = ({ children, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', ...style }}>{children}</td>;
