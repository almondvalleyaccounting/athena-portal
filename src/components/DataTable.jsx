import React, { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';

const font = "'Outfit', sans-serif";

/*
  Standard table for long lists (UI audit, Sprint 4): sortable column
  headings, paging, and rows that open a record — with Ctrl/Cmd-click or a
  middle click opening it in a new tab, like a link.

  Sort and page can be controlled by the caller (so they live in the page's
  URL) or left to the table: pass `sort`/`onSort` and `page`/`onPage` to
  control, or `defaultSort` to let the table hold them.

  columns: [{ key, label, width?, align?: 'left'|'right'|'center',
              render?: (row) => node, sortValue?: (row) => string|number|null,
              sortable?: boolean (default true), wrap?: boolean }]
  rowHref:    (row) => string — where a row goes; onOpen(href) navigates in-app
  onRowClick: (row) => void — for rows that open a drawer or modal instead
  rowStyle:   (row) => style — e.g. dim a deleted row
  footer:     (sortedRows) => { [colKey]: node } — a totals row over ALL
              filtered rows (not just the page)
  selection:  { selected: Set<key>, onChange(nextSet) } — adds a tickbox
              column; the heading box ticks every filtered row, not just the page
  pageSize:   default 50; 0 turns paging off

  Clicks on a button, link, input, select or label inside a row act on that
  control and do not open the row.
*/
export default function DataTable({
  columns, rows, rowKey = (r) => r.id, rowHref, onOpen, onRowClick, rowStyle,
  sort: sortProp, onSort: onSortProp, defaultSort = null,
  page: pageProp, onPage: onPageProp, pageSize = 50,
  footer, selection, empty = 'Nothing to show.',
}) {
  const [sortState, setSortState] = useState(defaultSort);
  const [pageState, setPageState] = useState(1);
  const sort = sortProp !== undefined ? sortProp : sortState;
  const onSort = onSortProp || ((s) => { setSortState(s); setPageState(1); });
  const page = pageProp !== undefined ? pageProp : pageState;
  const onPage = onPageProp || setPageState;

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!col) return rows;
    const get = col.sortValue || ((r) => r[col.key]);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = get(a); const vb = get(b);
      // Blanks always last, whichever way the column is sorted.
      const ea = va == null || va === ''; const eb = vb == null || vb === '';
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'en-GB', { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [rows, columns, sort]);

  const paged = pageSize > 0;
  const pages = paged ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(Math.max(1, page || 1), pages);
  const start = paged ? (current - 1) * pageSize : 0;
  const visible = paged ? sorted.slice(start, start + pageSize) : sorted;

  const clickSort = (col) => {
    if (col.sortable === false) return;
    const dir = sort?.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc';
    onSort({ key: col.key, dir });
  };

  const isControl = (el) => !!el.closest('button, a, input, select, textarea, label, [data-no-row-click]');
  const open = (e, row) => {
    if (isControl(e.target)) return;
    const href = rowHref?.(row);
    if (href) {
      if (e.ctrlKey || e.metaKey || e.button === 1) { window.open(href, '_blank', 'noopener'); return; }
      onOpen?.(href);
      return;
    }
    if (e.button === 0) onRowClick?.(row);
  };
  const clickable = !!(rowHref || onRowClick);

  const sel = selection?.selected;
  const allKeys = selection ? sorted.map(rowKey) : [];
  const allOn = selection && allKeys.length > 0 && allKeys.every((k) => sel.has(k));
  const someOn = selection && !allOn && allKeys.some((k) => sel.has(k));
  const toggleAll = () => {
    const next = new Set(sel);
    if (allOn) allKeys.forEach((k) => next.delete(k)); else allKeys.forEach((k) => next.add(k));
    selection.onChange(next);
  };
  const toggleOne = (k) => {
    const next = new Set(sel);
    if (next.has(k)) next.delete(k); else next.add(k);
    selection.onChange(next);
  };

  const foot = footer ? footer(sorted) : null;

  const th = { fontSize: 13, fontWeight: 600, color: '#64748b', padding: '10px 14px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', whiteSpace: 'nowrap', userSelect: 'none' };
  const td = { fontSize: 14, color: '#0f172a', padding: '11px 14px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };
  const pageBtn = (disabled) => ({ display: 'inline-flex', alignItems: 'center', padding: 6, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: disabled ? '#cbd5e1' : '#334155', cursor: disabled ? 'default' : 'pointer' });
  const cellStyle = (c) => ({
    ...td, textAlign: c.align || 'left',
    ...(c.wrap ? { whiteSpace: 'normal', wordBreak: 'break-word' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  });

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            {selection && <col style={{ width: 44 }} />}
            {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
          </colgroup>
          <thead>
            <tr>
              {selection && (
                <th style={{ ...th, textAlign: 'center', padding: '10px 0' }}>
                  <input
                    type="checkbox" aria-label={allOn ? 'Untick all' : `Tick all ${allKeys.length}`}
                    checked={!!allOn} ref={(el) => { if (el) el.indeterminate = !!someOn; }} onChange={toggleAll}
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const canSort = c.sortable !== false;
                return (
                  <th
                    key={c.key}
                    onClick={() => clickSort(c)}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    style={{ ...th, textAlign: c.align || 'left', cursor: canSort ? 'pointer' : 'default', color: active ? '#0f172a' : th.color }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {c.label}
                      {active && (sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const k = rowKey(row);
              return (
                <tr
                  key={k}
                  onClick={(e) => open(e, row)}
                  onAuxClick={(e) => { if (e.button === 1 && rowHref) open(e, row); }}
                  style={{ cursor: clickable ? 'pointer' : 'default', ...(sel?.has(k) ? { background: '#eff6ff' } : {}), ...(rowStyle?.(row) || {}) }}
                  onMouseEnter={(e) => { if (!sel?.has(k)) e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = sel?.has(k) ? '#eff6ff' : ''; }}
                >
                  {selection && (
                    <td style={{ ...td, textAlign: 'center', padding: '11px 0' }}>
                      <input type="checkbox" aria-label="Tick row" checked={sel.has(k)} onChange={() => toggleOne(k)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} style={cellStyle(c)}>
                      {c.render ? c.render(row) : (row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={columns.length + (selection ? 1 : 0)} style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: '40px 14px' }}>{empty}</td></tr>
            )}
          </tbody>
          {foot && sorted.length > 0 && (
            <tfoot>
              <tr>
                {selection && <td style={{ ...td, background: '#f8fafc', borderTop: '1px solid #e5e7eb' }} />}
                {columns.map((c) => (
                  <td key={c.key} style={{ ...cellStyle(c), fontWeight: 700, background: '#f8fafc', borderTop: '1px solid #e5e7eb', borderBottom: 'none' }}>
                    {foot[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {sorted.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 13.5, color: '#64748b', gap: 12, flexWrap: 'wrap' }}>
          <span>
            {paged ? `${start + 1}–${start + visible.length} of ${sorted.length}` : `${sorted.length} row${sorted.length === 1 ? '' : 's'}`}
            {selection && sel.size > 0 && <span style={{ marginLeft: 10, color: '#1E4560', fontWeight: 600 }}>· {sel.size} ticked</span>}
          </span>
          {pages > 1 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button aria-label="Previous page" disabled={current <= 1} onClick={() => onPage(current - 1)} style={pageBtn(current <= 1)}><ChevronLeft size={16} /></button>
              Page {current} of {pages}
              <button aria-label="Next page" disabled={current >= pages} onClick={() => onPage(current + 1)} style={pageBtn(current >= pages)}><ChevronRight size={16} /></button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
