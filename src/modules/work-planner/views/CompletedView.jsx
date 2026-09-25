import React, { useMemo, useState } from 'react';
import { durFmt, formatDateShort, clientName, staffName } from '../lib/helpers';
import Avatar from '../components/Avatar';
import { useWorkPlanner } from '../WorkPlannerModule';
import { deleteCompletedTask } from '../lib/supabaseQueries';
import DataTable from '../../../components/DataTable';
import { BTN } from '../../../lib/buttonStyles';

const sourceLabel = (t) => (t.source_type === 'quick' ? 'Quick' : 'Scheduled');

export default function CompletedView() {
  const { completedTasks, staffMap, entityMap, filters, progressNotes, staffColours } = useWorkPlanner();
  // The module only listens for completed_tasks INSERTs, so a deleted row would
  // otherwise stay on screen until a reload. Hide it here once the delete lands.
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'completed', dir: 'desc' });
  const [page, setPage] = useState(1);

  // Back to page 1 whenever the shared filters change, so a narrowed list is
  // not shown from the middle.
  const filterKey = `${filters.teamFilter || ''}|${filters.clientFilter || ''}|${filters.serviceFilter || ''}`;
  const [pageFilterKey, setPageFilterKey] = useState(filterKey);
  if (pageFilterKey !== filterKey) { setPageFilterKey(filterKey); setPage(1); }

  const list = useMemo(() => {
    let l = completedTasks.filter((t) => !deletedIds.has(t.id));
    if (filters.teamFilter) l = l.filter((t) => t.assignee_id === filters.teamFilter);
    if (filters.clientFilter) l = l.filter((t) => t.entity_id === filters.clientFilter);
    if (filters.serviceFilter) l = l.filter((t) => t.service === filters.serviceFilter);
    return l;
  }, [completedTasks, deletedIds, filters.teamFilter, filters.clientFilter, filters.serviceFilter]);

  // Build a lookup for completion notes by source_id
  const completionNoteMap = useMemo(() => {
    const m = {};
    progressNotes.forEach((n) => {
      if (n.is_completion) {
        if (!m[n.task_id]) m[n.task_id] = [];
        m[n.task_id].push(n);
      }
    });
    return m;
  }, [progressNotes]);

  async function handleDelete(task) {
    if (!window.confirm(`Delete completed task "${task.title}"?`)) return;
    try {
      await deleteCompletedTask(task.id);
      setDeletedIds((prev) => new Set(prev).add(task.id));
    } catch (e) {
      alert('Failed to delete: ' + (e.message || 'Unknown error'));
    }
  }

  const columns = [
    {
      key: 'assignee', label: 'Who', width: 64,
      sortValue: (t) => (t.assignee_id ? staffName(t.assignee_id, staffMap) : null),
      render: (t) => (t.assignee_id ? (
        <span title={staffName(t.assignee_id, staffMap)} style={{ display: 'inline-flex' }}>
          <Avatar id={t.assignee_id} staffMap={staffMap} size={20} customColour={staffColours?.[t.assignee_id]} />
        </span>
      ) : (
        <div
          title="Unassigned"
          style={{
            width: 20, height: 20, borderRadius: '50%',
            background: '#cbd5e1', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 600, color: '#fff',
          }}
        >
          ?
        </div>
      )),
    },
    {
      key: 'title', label: 'Task', wrap: true,
      sortValue: (t) => t.title || null,
      render: (t) => (
        <div>
          <div style={{
            fontSize: 13.5, fontWeight: 500, color: '#64748b',
            textDecoration: t.not_required ? 'none' : 'line-through',
          }}>
            {t.title}
            {t.not_required && (
              <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginLeft: 4 }}>
                not required
              </span>
            )}
          </div>
          {(completionNoteMap[t.source_id] || []).map((n) => (
            <div key={n.id} style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>
              &ldquo;{n.note}&rdquo;
              <span style={{ color: '#94a3b8', marginLeft: 4, fontSize: 11 }}>
                &mdash; {(n.created_by_name || '').split(' ')[0]}
              </span>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'client', label: 'Client', width: '20%',
      sortValue: (t) => (t.entity_id ? clientName(t.entity_id, entityMap) : null),
      render: (t) => (
        <span style={{ fontSize: 13, color: '#64748b' }}>
          {t.entity_id ? clientName(t.entity_id, entityMap) : ''}
        </span>
      ),
    },
    {
      key: 'service', label: 'Service', width: '14%',
      sortValue: (t) => t.service || null,
      render: (t) => <span style={{ fontSize: 13, color: '#64748b' }}>{t.service || ''}</span>,
    },
    {
      key: 'source', label: 'Type', width: 100,
      sortValue: sourceLabel,
      render: (t) => <span style={{ fontSize: 13, color: '#64748b' }}>{sourceLabel(t)}</span>,
    },
    {
      key: 'mins', label: 'Time', width: 80, align: 'right',
      sortValue: (t) => (t.completion_mins ? Number(t.completion_mins) : null),
      render: (t) => (t.completion_mins ? (
        <span style={{ fontSize: 13, color: '#0e7fe0', fontWeight: 500 }}>{durFmt(t.completion_mins)}</span>
      ) : null),
    },
    {
      key: 'completed', label: 'Completed', width: 110, align: 'right',
      sortValue: (t) => t.completed_at || null,
      render: (t) => (
        <span style={{ fontSize: 13, color: '#94a3b8' }}>
          {t.completed_at ? formatDateShort(t.completed_at) : ''}
        </span>
      ),
    },
    {
      key: 'delete', label: '', width: 80, align: 'right', sortable: false,
      render: (t) => (
        <button
          onClick={() => handleDelete(t)}
          aria-label={`Delete completed task ${t.title || ''}`}
          style={{ ...BTN.danger.sm, whiteSpace: 'nowrap' }}
        >
          Delete
        </button>
      ),
    },
  ];

  return (
    <div style={{ padding: '12px 20px', fontFamily: "'Outfit', sans-serif" }}>
      <DataTable
        columns={columns}
        rows={list}
        sort={sort}
        onSort={(next) => { setSort(next); setPage(1); }}
        page={page}
        onPage={setPage}
        // Done work reads faded and comes to full strength on hover, as before.
        rowStyle={() => ({ opacity: 0.6 })}
        empty="No completed tasks."
      />
    </div>
  );
}
