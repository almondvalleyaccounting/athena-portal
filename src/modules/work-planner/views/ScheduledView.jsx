import React, { useMemo, useState } from 'react';
import { formatDateShort, staffFirstName } from '../lib/helpers';
import { nextInstance } from '../lib/instanceEngine';
import { kindOf, cadenceLabel } from '../lib/blocksApi';
import Avatar from '../components/Avatar';
import { useWorkPlanner } from '../WorkPlannerModule';
import DataTable from '../../../components/DataTable';
import { BTN } from '../../../lib/buttonStyles';

// Blocks (sql/312, sql/314): the repeating blocks of time that are not
// BrightManager jobs. One row per block; the Planner shows the occurrences.

export default function ScheduledView({ onEdit }) {
  const { scheduledTasks, overridesMap, completedKeys, staffMap, entityMap, filters, staffColours, blockItemsMap } = useWorkPlanner();
  const [sort, setSort] = useState({ key: 'owner', dir: 'asc' });
  const [page, setPage] = useState(1);

  const list = useMemo(() => {
    let l = [...scheduledTasks];
    if (filters.teamFilter) l = l.filter((t) => t.assignee_id === filters.teamFilter);
    if (filters.serviceFilter) l = l.filter((t) => t.service === filters.serviceFilter);
    return l;
  }, [scheduledTasks, filters.teamFilter, filters.serviceFilter]);
  const nextMap = useMemo(() => new Map(list.map((m) => [m.id, nextInstance(m, overridesMap, completedKeys)])), [list, overridesMap, completedKeys]);

  const columns = [
    {
      key: 'owner', label: 'Who', width: 64,
      sortValue: (m) => staffFirstName(m.assignee_id, staffMap) || null,
      render: (m) => (m.assignee_id ? <span style={{ display: 'inline-flex' }}><Avatar id={m.assignee_id} staffMap={staffMap} customColour={staffColours?.[m.assignee_id]} /></span> : null),
    },
    { key: 'title', label: 'Block', wrap: true, sortValue: (m) => m.title || null, render: (m) => <span style={{ fontSize: 14, fontWeight: 500 }}>{m.title}</span> },
    { key: 'kind', label: 'Kind', width: 150, sortValue: (m) => kindOf(m.block_kind).label, render: (m) => <span style={{ fontSize: 12.5, color: '#64748b' }}>{m.block_kind ? kindOf(m.block_kind).label : 'Scheduled task'}</span> },
    { key: 'carry', label: 'If not done', width: 110, sortValue: (m) => (m.carry_over ? 1 : 0), render: (m) => <span style={{ fontSize: 12, color: m.carry_over ? '#0e7fe0' : '#94a3b8' }}>{m.carry_over ? 'Carries over' : 'Explained'}</span> },
    { key: 'cadence', label: 'When', width: 200, sortValue: (m) => cadenceLabel(m), render: (m) => <span style={{ fontSize: 12.5, color: '#64748b' }}>{cadenceLabel(m)}</span> },
    { key: 'hours', label: 'Hours', width: 70, align: 'right', sortValue: (m) => Number(m.duration) || 0, render: (m) => <span style={{ fontSize: 12.5 }}>{Math.round((Number(m.duration) || 0) / 6) / 10}h</span> },
    {
      key: 'clients', label: 'Sub-tasks', width: '22%', wrap: true,
      sortValue: (m) => (blockItemsMap[m.id] || []).length,
      render: (m) => {
        const items = blockItemsMap[m.id] || [];
        if (!items.length) return <span style={{ fontSize: 12, color: '#cbd5e1' }}>—</span>;
        const names = items.map((it) => entityMap[it.entity_id]?.name || it.label).filter(Boolean);
        return <span style={{ fontSize: 12, color: '#64748b' }} title={names.join(', ')}>{names.length} · {names.slice(0, 3).join(', ')}{names.length > 3 ? '…' : ''}</span>;
      },
    },
    {
      key: 'next', label: 'Next', width: 110,
      sortValue: (m) => { const ni = nextMap.get(m.id); return ni ? ni._date.getTime() : null; },
      render: (m) => { const ni = nextMap.get(m.id); return ni ? <span style={{ fontSize: 12, color: '#64748b' }}>{formatDateShort(ni._date)}</span> : <span style={{ fontSize: 12, color: '#cbd5e1' }}>—</span>; },
    },
    { key: 'edit', label: '', width: 70, align: 'right', sortable: false, render: (m) => <button onClick={() => onEdit(m)} style={{ ...BTN.secondary.sm, cursor: 'pointer' }}>Edit</button> },
  ];

  return (
    <div style={{ padding: 10 }}>
      <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8 }}>
        Repeating blocks of time that are not BrightManager jobs: mail, onboarding, confirmation statements, payroll. They sit on the Planner, count against capacity, and log to the timesheet when completed. Tag clients into a block and it breaks down by client.
      </div>
      <DataTable columns={columns} rows={list} rowKey={(m) => m.id} onRowClick={(m) => onEdit(m)} sort={sort} onSort={(next) => { setSort(next); setPage(1); }} page={page} onPage={setPage} empty="No blocks yet. Add one with + Block." />
    </div>
  );
}
