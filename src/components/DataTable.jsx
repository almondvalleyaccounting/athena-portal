import React, { useMemo } from 'react';
import { ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';

const font = "'Outfit', sans-serif";

/*
  Standard table for long lists (UI audit, Sprint 4): sortable column
  headings, paging, and rows that open a record — with Ctrl/Cmd-click or a
  middle click opening it in a new tab, like a link.

  Sorting and paging are controlled by the caller (so they can live in the
  page's URL); the table does the sorting and slicing itself.

  columns: [{ key, label, width?, align?: 'left'|'right',
              render?: (row) => node, sortValue?: (row) => string|number|null,
              sortable?: boolean (default true) }]
  sort:    { key, dir: 'asc'|'desc' }   onSort(nextSort)
  page:    1-based                       onPage(nextPage)
  rowHref: (row) => string — where a row goes; onOpen(href) navigates in-app
*/
export default function DataTable({
  columns, rows, rowKey = (r) => r.id, rowHref, onOpen,
  sort, onSort, page = 1, onPage, pageSize = 50, empty = 'Nothing to show.',
}) {
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

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);

  const clickSort = (col) => {
    if (col.sortable === false || !onSort) return;
    const dir = sort?.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc';
    onSort({ key: col.key, dir });
  };

  const open = (e, row) => {
    const href = rowHref?.(row);
    if (!href) return;
    if (e.ctrlKey || e.metaKey || e.button === 1) { window.open(href, '_blank', 'noopener'); return; }
    onOpen?.(href);
  };

  const th = { fontSize: 13, fontWeight: 600, color: '#64748b', padding: '10px 14px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', whiteSpace: 'nowrap', userSelect: 'none' };
  const td = { fontSize: 14, color: '#0f172a', padding: '11px 14px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' };
  const pageBtn = (disabled) => ({ display: 'inline-flex', alignItems: 'center', padding: 6, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', color: disabled ? '#cbd5e1' : '#334155', cursor: disabled ? 'default' : 'pointer' });

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const canSort = c.sortable !== false && !!onSort;
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
            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={(e) => open(e, row)}
                onAuxClick={(e) => { if (e.button === 1) open(e, row); }}
                style={{ cursor: rowHref ? 'pointer' : 'default' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ ...td, textAlign: c.align || 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.render ? c.render(row) : (row[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={columns.length} style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: '40px 14px' }}>{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sorted.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 13.5, color: '#64748b' }}>
          <span>{start + 1}–{start + visible.length} of {sorted.length}</span>
          {pages > 1 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button aria-label="Previous page" disabled={current <= 1} onClick={() => onPage?.(current - 1)} style={pageBtn(current <= 1)}><ChevronLeft size={16} /></button>
              Page {current} of {pages}
              <button aria-label="Next page" disabled={current >= pages} onClick={() => onPage?.(current + 1)} style={pageBtn(current >= pages)}><ChevronRight size={16} /></button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
