import React, { useState, useEffect } from 'react';
import { fetchImportHistory, fetchStaffNames } from '../lib/importQueries';
import { SOURCES, getSource, getSystemLabel } from '../lib/sources';

const font = "'Outfit', sans-serif";

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusColor(s) {
  if (s === 'complete') return { bg: '#ecfdf5', fg: '#065f46' };
  if (s === 'failed') return { bg: '#fee2e2', fg: '#991b1b' };
  if (s === 'cancelled') return { bg: '#f1f5f9', fg: '#475569' };
  return { bg: '#fef3c7', fg: '#78350f' };
}

export default function HistoryView() {
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [sinceDays, setSinceDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [names, setNames] = useState({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await fetchImportHistory({ source, status, sinceDays });
        setRows(data);
        const ids = [
          ...data.map((r) => r.triggered_by),
          ...data.map((r) => r.approved_by),
        ];
        setNames(await fetchStaffNames(ids));
      } catch (e) {
        console.error('[DataImport] history error:', e);
        setRows([]);
      }
      setLoading(false);
    })();
  }, [source, status, sinceDays]);

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 1180 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <Filter label="Source">
          <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            {SOURCES.map((s) => <option key={s.key} value={s.key}>{getSystemLabel(s.system)} — {s.name}</option>)}
          </select>
        </Filter>
        <Filter label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            <option value="complete">Complete</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Filter>
        <Filter label="Date range">
          <select value={sinceDays} onChange={(e) => setSinceDays(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={selectStyle}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </Filter>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading history…</p>
      ) : rows.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>No imports yet</p>
          <p style={{ fontSize: 13, color: '#cbd5e1' }}>Import records will appear here after your first run.</p>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <thead>
            <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
              <Th>Source</Th>
              <Th>File</Th>
              <Th>Date / Time</Th>
              <Th>By</Th>
              <Th>Written</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const src = getSource(r.source_key);
              const total = Object.values(r.row_counts || {}).reduce((s, n) => s + Number(n || 0), 0);
              const sc = statusColor(r.status);
              const isOpen = expanded === r.id;
              return (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setExpanded(isOpen ? null : r.id)} style={{ cursor: 'pointer', borderTop: '1px solid #f1f5f9' }}>
                    <Td>{src ? `${getSystemLabel(src.system)} — ${src.name}` : r.source_key}</Td>
                    <Td style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11 }}>{r.file_name}</Td>
                    <Td>{formatDateTime(r.triggered_at)}</Td>
                    <Td>{names[r.triggered_by] || '—'}</Td>
                    <Td style={{ fontFamily: 'monospace' }}>{total.toLocaleString()}</Td>
                    <Td>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999, background: sc.bg, color: sc.fg, textTransform: 'capitalize' }}>
                        {r.status}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: '#fafafa' }}>
                      <td colSpan={6} style={{ padding: 16, borderTop: '1px solid #f1f5f9' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, fontSize: 12 }}>
                          <DetailBlock label="Row counts">
                            {Object.keys(r.row_counts || {}).length === 0 ? <span style={{ color: '#cbd5e1' }}>none</span> :
                              Object.entries(r.row_counts).map(([t, n]) => (
                                <div key={t}>{Number(n).toLocaleString()} → {t}</div>
                              ))}
                          </DetailBlock>
                          <DetailBlock label="Approved by">
                            {r.approved_by ? (
                              <>
                                <div>{names[r.approved_by] || r.approved_by}</div>
                                <div style={{ color: '#94a3b8' }}>{formatDateTime(r.approved_at)}</div>
                              </>
                            ) : <span style={{ color: '#cbd5e1' }}>not approved</span>}
                          </DetailBlock>
                          <DetailBlock label="File">
                            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', wordBreak: 'break-all' }}>
                              {r.file_hash?.slice(0, 16)}…
                            </div>
                            <div style={{ color: '#94a3b8' }}>{r.file_size ? `${(r.file_size / 1024).toFixed(1)} KB` : ''}</div>
                          </DetailBlock>
                          {(r.errors?.length > 0) && (
                            <DetailBlock label="Errors" wide>
                              {r.errors.map((e, i) => <div key={i} style={{ color: '#991b1b' }}>• {e.message || JSON.stringify(e)}</div>)}
                            </DetailBlock>
                          )}
                          {(r.warnings?.length > 0) && (
                            <DetailBlock label="Warnings" wide>
                              {r.warnings.slice(0, 10).map((w, i) => <div key={i} style={{ color: '#78350f' }}>• {w.message || JSON.stringify(w)}</div>)}
                              {r.warnings.length > 10 && <div style={{ color: '#94a3b8' }}>… {r.warnings.length - 10} more</div>}
                            </DetailBlock>
                          )}
                          {r.notes && (
                            <DetailBlock label="Notes" wide>
                              <div>{r.notes}</div>
                            </DetailBlock>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Filter({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      {children}
    </div>
  );
}
function DetailBlock({ label, children, wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <p style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</p>
      <div style={{ color: '#1e293b' }}>{children}</div>
    </div>
  );
}
const Th = ({ children }) => <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, style }) => <td style={{ padding: '10px 14px', ...style }}>{children}</td>;
const selectStyle = { padding: '5px 10px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
