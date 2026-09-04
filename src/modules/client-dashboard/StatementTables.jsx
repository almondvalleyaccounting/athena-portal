import React, { useState } from 'react';
import { money, moneyCompact, shortDate, shortMonth, percentChange, OUTFIT } from './dashboardData';

/*
  The two statement tables, shared by the staff dashboard and the client portal.

  These used to live inside ClientDashboardPage. They moved because the client's
  own dashboard now shows the SAME statements staff read, expandable to account
  level, and the alternative was a second implementation that looked like this
  one. A lookalike is worse than no client statement at all: the client rings up
  about a figure, and the two of you are reading tables that agree today and
  drift apart at the first change to either.

  So there is one component. What differs between the two apps is the palette
  and the type scale, which are props, and the tone of the surrounding copy,
  which is the caller's business.

  Nothing here fetches or derives. Rows arrive already parsed and bucketed by
  dashboardData (parseReportTree / bucketReportTree / mergeReportTrees), so the
  arithmetic a client sees is the arithmetic staff see, by construction rather
  than by intention.
*/

/*
  The disclosure chevron, drawn rather than imported.

  This module is reached from the client portal through the @dash alias, and
  that alias carries a rule: a shared module may import nothing but React and
  its own siblings. The portal has no lucide-react and should not gain one for
  two triangles — and the failure mode if it did is the bad kind, because Vite's
  dev server resolves a missing dependency happily enough and the rollup
  production build is where it stops, i.e. on master, in front of prod.
*/
function Chevron({ open, color }) {
  return (
    <svg
      width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ─── Palettes ─────────────────────────────────────────────────── */
// The staff app's greys, and the portal's softer set. A caller may pass its own;
// every key is used, so a partial palette is spread over this one.
export const STAFF_PALETTE = {
  font: OUTFIT,
  text: '#475569',
  strong: '#0f172a',
  faint: '#94a3b8',
  negative: '#991b1b',
  border: '#e5e7eb',
  rowBorder: '#f1f5f9',
  summaryBg: '#f8fafc',
  surface: '#ffffff',
  size: 12.5,
  headSize: 11,
};

/* ─── Expandable report table (P&L / balance sheet) ────────────── */
/*
  `columnKinds` says how to READ each column, not how to style it: 'money' or
  'pct'. A movement percentage rendered through the money formatter reads
  "£12" when it means 12%, which is the sort of thing that survives review
  because it looks like a number either way.

  `dividerAt` draws a rule before that column index — the seam between the two
  statements and the movement between them.

  `startExpanded` opens every section on first render. The portal uses it: a
  client who has never seen the page does not know the rows are clickable, and
  a collapsed statement looks like the whole statement.
*/
export function ReportTable({
  columns, rows, monthLabels = true, columnKinds = null, dividerAt = null,
  palette = null, startExpanded = false,
}) {
  const t = palette ? { ...STAFF_PALETTE, ...palette } : STAFF_PALETTE;

  const [expanded, setExpanded] = useState(() => {
    if (!startExpanded) return new Set();
    // Top level only. Opening every descendant of a deep chart of accounts
    // presents a client with three hundred nominal codes and no statement.
    return new Set((rows || []).filter((r) => r.kind === 'section').map((r) => r.id));
  });
  const toggle = (id) => setExpanded((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const visible = [];
  const push = (node, depth) => {
    if (node.kind === 'section') {
      const open = expanded.has(node.id);
      const expandable = (node.children || []).length > 0;
      visible.push({ node, depth, open, expandable, kind: 'section' });
      if (open) {
        node.children.forEach((c) => push(c, depth + 1));
        if (node.totals) {
          visible.push({
            node: { id: `${node.id}_total`, label: node.totalLabel || `Total ${node.label}`, values: node.totals },
            depth, kind: 'sectionTotal',
          });
        }
      }
    } else if (node.kind === 'summary') {
      visible.push({ node, depth, kind: 'summary' });
    } else {
      visible.push({ node, depth, kind: 'row' });
    }
  };
  (rows || []).forEach((r) => push(r, 0));

  const cellNum = (v, i) => {
    if (v === null || v === undefined) return '';
    return columnKinds?.[i] === 'pct' ? percentChange(v) : moneyCompact(v);
  };
  const numStyle = {
    fontFamily: t.font, fontSize: `${t.size}px`, textAlign: 'right', padding: '7px 10px',
    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: t.text,
  };
  const divider = (i) => (dividerAt != null && i === dividerAt
    ? { borderLeft: `1px solid ${t.border}` } : null);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: `${220 + columns.length * 78}px` }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${t.border}` }}>
            <th style={{ ...numStyle, fontSize: `${t.headSize}px`, textAlign: 'left', color: t.faint, fontWeight: 600, position: 'sticky', left: 0, backgroundColor: t.surface }} />
            {columns.map((c, i) => (
              <th key={i} style={{ ...numStyle, fontSize: `${t.headSize}px`, color: t.faint, fontWeight: 600, ...divider(i) }}>
                {monthLabels ? shortMonth(c) : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map(({ node, depth, open, expandable, kind }) => {
            const isBold = kind === 'section' || kind === 'summary' || kind === 'sectionTotal';
            const vals = kind === 'section' ? (open ? null : node.totals) : node.values;
            return (
              <tr
                key={node.id}
                onClick={kind === 'section' && expandable ? () => toggle(node.id) : undefined}
                style={{
                  borderBottom: `1px solid ${t.rowBorder}`,
                  cursor: kind === 'section' && expandable ? 'pointer' : 'default',
                  backgroundColor: kind === 'summary' ? t.summaryBg : 'transparent',
                }}
              >
                <td style={{
                  ...numStyle, textAlign: 'left', paddingLeft: `${10 + depth * 18}px`,
                  fontWeight: isBold ? 700 : 400, color: isBold ? t.strong : t.text,
                  position: 'sticky', left: 0, backgroundColor: kind === 'summary' ? t.summaryBg : t.surface,
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    {kind === 'section' && expandable && <Chevron open={open} color={t.faint} />}
                    {node.label}
                  </span>
                </td>
                {columns.map((_, i) => (
                  <td key={i} style={{
                    ...numStyle,
                    fontWeight: isBold ? 700 : 400,
                    color: vals && vals[i] !== null && vals[i] < 0 ? t.negative : isBold ? t.strong : t.text,
                    ...divider(i),
                  }}>
                    {vals ? cellNum(vals[i], i) : ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Aged debtors / creditors ─────────────────────────────────── */
export const BUCKET_DEFS = [
  ['current', 'Current'],
  ['b1_30', '1–30 days'],
  ['b31_60', '31–60 days'],
  ['b61_90', '61–90 days'],
  ['b91_plus', '91+ days'],
];

/*
  `sameLabel` names what the same-client comparison is comparing — "Same
  debtors", "Same suppliers" — because the comparison is deliberately NOT the
  aged total at three dates. It is the balances of the names on the file NOW,
  read back in time, so a customer who has since left cannot make the ledger
  look as though it improved.
*/
export function AgedSection({ title, data, currency, sameLabel, palette = null, cardStyle = null }) {
  const t = palette ? { ...STAFF_PALETTE, ...palette } : STAFF_PALETTE;
  if (!data) return null;
  const top = (data.top || []).slice(0, 10);
  const sc = data.same_clients;

  const th = { fontFamily: t.font, fontSize: `${t.headSize}px`, color: t.faint, fontWeight: 600, textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap' };
  const td = { fontFamily: t.font, fontSize: `${t.size}px`, textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const tile = { backgroundColor: t.summaryBg, borderRadius: '10px', padding: '10px 12px' };

  return (
    <div style={cardStyle || undefined}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <span style={{ fontFamily: t.font, fontSize: '15px', fontWeight: 700, color: t.strong }}>{title}</span>
        <span style={{ fontFamily: t.font, fontSize: '18px', fontWeight: 700, color: t.strong, marginLeft: 'auto' }}>
          {money(data.buckets?.total, currency)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{ fontFamily: t.font, fontSize: '11.5px', color: t.faint }}>
          as at {shortDate(data.period?.end)}
        </span>
      </div>

      {/* Same-client comparison — the CURRENT list's balances back in time */}
      {sc && (sc.last_month?.total != null || sc.three_months?.total != null) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
          {[
            ['Now', sc.current_total, data.period?.end],
            ['Last month', sc.last_month?.total, sc.last_month?.date],
            ['3 months ago', sc.three_months?.total, sc.three_months?.date],
          ].map(([label, val, date]) => (
            <div key={label} style={tile}>
              <div style={{ fontFamily: t.font, fontSize: '11px', color: t.faint, marginBottom: '2px' }}>{label}</div>
              <div style={{ fontFamily: t.font, fontSize: '16px', fontWeight: 700, color: t.strong }}>
                {val == null ? '—' : money(val, currency)}
              </div>
              <div style={{ fontFamily: t.font, fontSize: '10.5px', color: t.border }}>{date ? shortDate(date) : ''}</div>
            </div>
          ))}
          <div style={{ gridColumn: '1 / -1', fontFamily: t.font, fontSize: '11px', color: t.faint, marginTop: '-4px' }}>
            {sameLabel} on the current file ({sc.names}) — their combined balance at each date. Names on the file now only.
          </div>
        </div>
      )}

      {/* Ageing buckets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        {BUCKET_DEFS.map(([key, label]) => (
          <div key={key} style={tile}>
            <div style={{ fontFamily: t.font, fontSize: '11px', color: t.faint, marginBottom: '2px' }}>{label}</div>
            <div style={{ fontFamily: t.font, fontSize: '16px', fontWeight: 700, color: key === 'b91_plus' && Math.abs(data.buckets?.[key] || 0) > 0.005 ? t.negative : t.strong }}>
              {money(data.buckets?.[key], currency)}
            </div>
          </div>
        ))}
      </div>

      {/* Top balances */}
      {top.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${t.border}` }}>
                <th style={{ ...th, textAlign: 'left' }}>Largest balances</th>
                {BUCKET_DEFS.map(([k, l]) => <th key={k} style={th}>{l}</th>)}
                <th style={th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${t.rowBorder}` }}>
                  <td style={{ ...td, textAlign: 'left', color: t.strong, fontWeight: 500 }}>{r.name}</td>
                  {BUCKET_DEFS.map(([k]) => (
                    <td key={k} style={{ ...td, color: k === 'b91_plus' && Math.abs(r[k] || 0) > 0.005 ? t.negative : t.text }}>
                      {Math.abs(r[k] || 0) > 0.005 ? money(r[k], currency) : ''}
                    </td>
                  ))}
                  <td style={{ ...td, fontWeight: 700, color: t.strong }}>{money(r.total, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
