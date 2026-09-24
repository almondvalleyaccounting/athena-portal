import React, { useMemo, useState } from 'react';
import DataTable from '../../components/DataTable';
import {
  CATEGORIES, CATEGORY_MAP, STAGES, STAGE_MAP, PRIORITY_MAP, chip, font, smallInput,
  fmtDateShort, nextOpenAction, daysOpen, caseHeadline,
} from './triageShared';

// Every case as one sortable, filterable table — the old Issues Log's list,
// now covering everything on the board.

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

const none = <span style={{ color: '#cbd5e1' }}>—</span>;
const today = () => new Date().toISOString().slice(0, 10);

// Blank values (no owner, no date) sort last whichever way the column runs.
function buildColumns(staffMap, actionsByCase) {
  return [
    {
      key: 'client', label: 'Client', width: '15%',
      sortValue: (c) => caseHeadline(c).toLowerCase(),
      render: (c) => <span style={{ fontWeight: 600, color: '#0f172a' }}>{caseHeadline(c)}</span>,
    },
    {
      key: 'type', label: 'Type', width: '8%',
      sortValue: (c) => c.category,
      render: (c) => { const cat = CATEGORY_MAP[c.category] || CATEGORY_MAP.general; return <span style={chip(cat.tone)}>{cat.short}</span>; },
    },
    {
      key: 'stage', label: 'Stage', width: '10%',
      sortValue: (c) => STAGE_RANK[c.stage] ?? 9,
      render: (c) => { const st = STAGE_MAP[c.stage] || STAGE_MAP.not_started; return <span style={chip(st.tone)}>{st.label}</span>; },
    },
    {
      key: 'what', label: 'What', wrap: true,
      sortValue: (c) => (c.title || c.description || '').toLowerCase(),
      render: (c) => (
        <>
          {c.title && <div style={{ fontWeight: 600 }}>{c.title}</div>}
          <div style={{ color: '#64748b', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.description}</div>
        </>
      ),
    },
    {
      key: 'owner', label: 'Owner', width: '9%',
      sortValue: (c) => (staffMap[c.assignee_id] || '').toLowerCase() || null,
      render: (c) => staffMap[c.assignee_id] || none,
    },
    {
      key: 'priority', label: 'Priority', width: '7%',
      sortValue: (c) => PRIORITY_RANK[c.priority] ?? 9,
      render: (c) => {
        const pr = c.priority && PRIORITY_MAP[c.priority];
        return pr ? <span style={{ color: pr.fg, fontWeight: 600 }}>{pr.label}</span> : none;
      },
    },
    {
      key: 'next', label: 'Next action', width: '15%', wrap: true,
      sortValue: (c) => nextOpenAction(actionsByCase[c.id] || [])?.target_date || null,
      render: (c) => {
        const next = nextOpenAction(actionsByCase[c.id] || []);
        if (next) return <>{next.title}{next.target_date && <span style={{ color: '#94a3b8' }}> · {fmtDateShort(next.target_date)}</span>}</>;
        return c.next_action || none;
      },
    },
    {
      key: 'target', label: 'Target', width: '8%',
      sortValue: (c) => c.target_date || null,
      render: (c) => {
        if (!c.target_date) return none;
        const overdue = c.target_date < today() && c.status === 'open';
        return <span style={{ color: overdue ? '#dc2626' : undefined }}>{fmtDateShort(c.target_date)}</span>;
      },
    },
    {
      key: 'age', label: 'Open', width: '5%',
      sortValue: (c) => -daysOpen(c.created_at),
      render: (c) => <span style={{ color: '#94a3b8' }}>{daysOpen(c.created_at)}d</span>,
    },
  ];
}

export default function ListView({ cases, actionsByCase, staffMap, staffList, onOpen }) {
  const [sort, setSort] = useState({ key: 'stage', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');

  const columns = useMemo(() => buildColumns(staffMap, actionsByCase), [staffMap, actionsByCase]);

  // Cases arrive newest first, and the table's sort is stable, so ties within
  // a sorted column stay newest first.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases.filter((c) => {
      if (type && c.category !== type) return false;
      if (stage && c.stage !== stage) return false;
      if (owner === '__none' ? c.assignee_id : owner && c.assignee_id !== owner) return false;
      if (needle && ![caseHeadline(c), c.title, c.description].some((v) => (v || '').toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [cases, type, stage, owner, q]);

  const filter = (set) => (e) => { set(e.target.value); setPage(1); };

  return (
    <div style={{ fontFamily: font }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={q} onChange={filter(setQ)} placeholder="Search client or description…"
          style={{ ...smallInput, minWidth: 240, flex: '0 1 320px' }} />
        <select value={type} onChange={filter(setType)} style={smallInput}>
          <option value="">All types</option>
          {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={stage} onChange={filter(setStage)} style={smallInput}>
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select value={owner} onChange={filter(setOwner)} style={smallInput}>
          <option value="">Anyone</option>
          <option value="__none">No owner</option>
          {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 'auto' }}>{rows.length} case{rows.length === 1 ? '' : 's'}</span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        sort={sort}
        onSort={(s) => { setSort(s); setPage(1); }}
        page={page}
        onPage={setPage}
        onRowClick={(c) => onOpen(c)}
        empty="No cases match."
      />
    </div>
  );
}
