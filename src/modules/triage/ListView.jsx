import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  CATEGORIES, CATEGORY_MAP, STAGES, STAGE_MAP, PRIORITY_MAP, card, chip, font, smallInput,
  fmtDateShort, nextOpenAction, daysOpen, caseHeadline,
} from './triageShared';

// Every case as one sortable, filterable table — the old Issues Log's list,
// now covering everything on the board.

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

const COLUMNS = [
  { key: 'client', label: 'Client', sort: (c) => caseHeadline(c).toLowerCase() },
  { key: 'type', label: 'Type', sort: (c) => c.category },
  { key: 'stage', label: 'Stage', sort: (c) => STAGE_RANK[c.stage] ?? 9 },
  { key: 'what', label: 'What', sort: (c) => (c.title || c.description || '').toLowerCase() },
  { key: 'owner', label: 'Owner', sort: (c, staffMap) => (staffMap[c.assignee_id] || '~').toLowerCase() },
  { key: 'priority', label: 'Priority', sort: (c) => PRIORITY_RANK[c.priority] ?? 9 },
  { key: 'next', label: 'Next action', sort: (c, _s, actionsByCase) => nextOpenAction(actionsByCase[c.id] || [])?.target_date || '9999' },
  { key: 'target', label: 'Target', sort: (c) => c.target_date || '9999' },
  { key: 'age', label: 'Open', sort: (c) => -daysOpen(c.created_at) },
];

export default function ListView({ cases, actionsByCase, staffMap, staffList, onOpen }) {
  const [sortKey, setSortKey] = useState('stage');
  const [asc, setAsc] = useState(true);
  const [type, setType] = useState('');
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = cases.filter((c) => {
      if (type && c.category !== type) return false;
      if (stage && c.stage !== stage) return false;
      if (owner === '__none' ? c.assignee_id : owner && c.assignee_id !== owner) return false;
      if (needle && ![caseHeadline(c), c.title, c.description].some((v) => (v || '').toLowerCase().includes(needle))) return false;
      return true;
    });
    const col = COLUMNS.find((x) => x.key === sortKey) || COLUMNS[2];
    return list.sort((a, b) => {
      const va = col.sort(a, staffMap, actionsByCase);
      const vb = col.sort(b, staffMap, actionsByCase);
      if (va === vb) return (b.created_at || '').localeCompare(a.created_at || '');
      return (va < vb ? -1 : 1) * (asc ? 1 : -1);
    });
  }, [cases, type, stage, owner, q, sortKey, asc, staffMap, actionsByCase]);

  function toggleSort(key) {
    if (key === sortKey) setAsc((v) => !v);
    else { setSortKey(key); setAsc(true); }
  }

  const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#f8fafc', cursor: 'pointer', userSelect: 'none' };
  const td = { padding: '8px 10px', fontSize: 12.5, color: '#334155', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or description…"
          style={{ ...smallInput, minWidth: 240, flex: '0 1 320px' }} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={smallInput}>
          <option value="">All types</option>
          {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)} style={smallInput}>
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} style={smallInput}>
          <option value="">Anyone</option>
          <option value="__none">No owner</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 'auto' }}>{rows.length} case{rows.length === 1 ? '' : 's'}</span>
      </div>

      <div style={{ ...card, overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: font }}>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} style={th} onClick={() => toggleSort(col.key)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {col.label}
                    {sortKey === col.key && (asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length} style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: 24 }}>No cases match.</td></tr>
            )}
            {rows.map((c) => {
              const cat = CATEGORY_MAP[c.category] || CATEGORY_MAP.general;
              const st = STAGE_MAP[c.stage] || STAGE_MAP.not_started;
              const pr = c.priority && PRIORITY_MAP[c.priority];
              const next = nextOpenAction(actionsByCase[c.id] || []);
              const overdue = c.target_date && c.target_date < new Date().toISOString().slice(0, 10) && c.status === 'open';
              return (
                <tr key={c.id} onClick={() => onOpen(c)} style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}>
                  <td style={{ ...td, fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap' }}>{caseHeadline(c)}</td>
                  <td style={td}><span style={chip(cat.tone)}>{cat.short}</span></td>
                  <td style={td}><span style={chip(st.tone)}>{st.label}</span></td>
                  <td style={{ ...td, maxWidth: 420 }}>
                    {c.title && <div style={{ fontWeight: 600 }}>{c.title}</div>}
                    <div style={{ color: '#64748b', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.description}</div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{staffMap[c.assignee_id] || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: pr?.fg, fontWeight: pr ? 600 : 400 }}>{pr?.label || <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...td, maxWidth: 220 }}>
                    {next ? <>{next.title}{next.target_date && <span style={{ color: '#94a3b8' }}> · {fmtDateShort(next.target_date)}</span>}</>
                      : c.next_action || <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: overdue ? '#dc2626' : undefined }}>{c.target_date ? fmtDateShort(c.target_date) : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: '#94a3b8' }}>{daysOpen(c.created_at)}d</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
