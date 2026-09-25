import React, { useState } from 'react';
import { SOURCES } from '../lib/constants';
import { durFmt, formatDateShort, clientName, staffFirstName, getStatus } from '../lib/helpers';
import { nextInstance } from '../lib/instanceEngine';
import Avatar from '../components/Avatar';
import { useWorkPlanner } from '../WorkPlannerModule';
import DataTable from '../../../components/DataTable';
import { BTN } from '../../../lib/buttonStyles';

// The filter bar's Sort choice names a column here; anything else sorts by title.
const SORT_KEYS = ['title', 'client', 'service', 'owner', 'next'];
const sortFromProp = (s) => ({ key: SORT_KEYS.includes(s) ? s : 'title', dir: 'asc' });

export default function ScheduledView({ sort: sortProp, onEdit }) {
  const {
    scheduledTasks, overridesMap, completedKeys, staffMap, entityMap,
    filters, highlightId, notesMap, addProgressNote, staffColours,
  } = useWorkPlanner();

  const [noteInput, setNoteInput] = useState(null);
  const [noteText, setNoteText] = useState('');

  // The filter bar's Sort dropdown still drives the order: choosing an option
  // there sorts the table by that column. Clicking a heading re-sorts from here.
  const [sort, setSort] = useState(() => sortFromProp(sortProp));
  const [sortFor, setSortFor] = useState(sortProp);
  const [page, setPage] = useState(1);
  if (sortFor !== sortProp) { setSortFor(sortProp); setSort(sortFromProp(sortProp)); setPage(1); }

  // Back to page 1 whenever the shared filters change, so a narrowed list is
  // not shown from the middle. Paging is controlled so adding a note never
  // jumps the page.
  const filterKey = `${filters.teamFilter || ''}|${filters.clientFilter || ''}|${filters.serviceFilter || ''}|${filters.statusFilter || ''}`;
  const [pageFilterKey, setPageFilterKey] = useState(filterKey);
  if (pageFilterKey !== filterKey) { setPageFilterKey(filterKey); setPage(1); }

  // Filter
  let list = [...scheduledTasks];
  if (filters.teamFilter) list = list.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) list = list.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) list = list.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) list = list.filter((t) => t.status === filters.statusFilter);

  // Each master's next instance, worked out once per render for both the
  // display and the "Next due" sort.
  const nextMap = new Map(list.map((m) => [m.id, nextInstance(m, overridesMap, completedKeys)]));

  const saveNote = async (master) => {
    if (noteText.trim()) await addProgressNote('scheduled', master.id, noteText.trim());
    setNoteText(''); setNoteInput(null);
  };

  const columns = [
    {
      key: 'owner', label: 'Who', width: 64,
      sortValue: (m) => staffFirstName(m.assignee_id, staffMap) || null,
      render: (m) => {
        const ni = nextMap.get(m.id);
        const displayAssignee = ni ? ni.assignee_id : m.assignee_id;
        return displayAssignee ? (
          <span style={{ display: 'inline-flex' }}>
            <Avatar id={displayAssignee} staffMap={staffMap} customColour={staffColours?.[displayAssignee]} />
          </span>
        ) : null;
      },
    },
    {
      key: 'title', label: 'Task', wrap: true,
      sortValue: (m) => m.title || null,
      render: (master) => {
        const ni = nextMap.get(master.id);
        const noteCount = (notesMap[`master:${master.id}`] || []).length;
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {master.title}
              {master.recurring && (
                <span style={{
                  padding: '1px 5px', fontSize: 11, borderRadius: 3,
                  background: '#dbeafe', color: '#0e7fe0', fontWeight: 500,
                }}>
                  {master.recurrence}
                </span>
              )}
              {ni && ni._hasOverride && (
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
              )}
              {noteCount > 0 && (
                <span style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 3, fontSize: 10, color: '#64748b', fontWeight: 600 }}>
                  {noteCount} note{noteCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Progress note input */}
            {noteInput === master.id ? (
              <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'flex-start' }}>
                <input
                  autoFocus
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && noteText.trim()) {
                      await addProgressNote('scheduled', master.id, noteText.trim());
                      setNoteText(''); setNoteInput(null);
                    }
                    if (e.key === 'Escape') { setNoteInput(null); setNoteText(''); }
                  }}
                  placeholder="Progress note..."
                  style={{
                    flex: 1, padding: '3px 6px', fontSize: 12,
                    fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                    borderRadius: 3, outline: 'none',
                  }}
                />
                <button
                  onClick={() => saveNote(master)}
                  style={{ ...BTN.primary.sm, cursor: 'pointer' }}
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setNoteInput(master.id); setNoteText(''); }}
                style={{ ...BTN.secondary.sm, cursor: 'pointer', marginTop: 3 }}
              >
                + Add note
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: 'client', label: 'Client', width: '18%', wrap: true,
      sortValue: (m) => (m.entity_id ? clientName(m.entity_id, entityMap) || null : null),
      render: (master) => (master.entity_id ? (
        <span
          data-no-row-click
          onClick={(e) => { e.stopPropagation(); window.location.href = `/clients/${master.entity_id}`; }}
          style={{ cursor: 'pointer', color: '#0e7fe0', fontSize: 13 }}
          onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
        >
          {clientName(master.entity_id, entityMap)}
        </span>
      ) : null),
    },
    {
      key: 'service', label: 'Service', width: '13%', wrap: true,
      sortValue: (m) => m.service || null,
      render: (m) => (m.service ? <span style={{ fontSize: 13, color: '#94a3b8' }}>{m.service}</span> : null),
    },
    {
      key: 'source', label: 'Source', width: 120,
      sortValue: (m) => { const src = SOURCES.find((s) => s.id === m.source); return src ? src.label : m.source || null; },
      render: (master) => {
        const src = SOURCES.find((s) => s.id === master.source);
        const srcStyle = master.source === 'brightmanager'
          ? { color: '#15803d', background: '#f0fdf4' }
          : master.source === 'payroll_checklist'
          ? { color: '#a16207', background: '#fefce8' }
          : { color: '#64748b', background: '#f1f5f9' };
        return (
          <span style={{ padding: '1px 5px', fontSize: 11, borderRadius: 3, fontWeight: 500, ...srcStyle }}>
            {src ? src.label : master.source}
          </span>
        );
      },
    },
    {
      key: 'status', label: 'Status', width: 130,
      sortValue: (m) => { const ni = nextMap.get(m.id); return ni ? getStatus(ni.status)?.label || null : null; },
      render: (m) => {
        const ni = nextMap.get(m.id);
        const st = ni ? getStatus(ni.status) : null;
        return st ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 7px', borderRadius: 12, fontSize: 12, fontWeight: 500,
            background: st.colour + '14', color: st.colour,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: st.colour }} />
            {st.label}
          </span>
        ) : null;
      },
    },
    {
      key: 'next', label: 'Next due', width: 120,
      sortValue: (m) => { const ni = nextMap.get(m.id); return ni ? ni._date.getTime() : null; },
      render: (m) => {
        const ni = nextMap.get(m.id);
        return ni
          ? <span style={{ fontSize: 12, color: '#64748b' }}>Next: {formatDateShort(ni._date)}</span>
          : <span style={{ fontSize: 12, color: '#cbd5e1' }}>No upcoming</span>;
      },
    },
    {
      key: 'duration', label: 'Time', width: 80, align: 'right',
      sortValue: (m) => (m.duration != null ? Number(m.duration) : null),
      render: (m) => <span style={{ fontSize: 12, color: '#94a3b8' }}>{durFmt(m.duration)}</span>,
    },
    {
      key: 'edit', label: '', width: 70, align: 'right', sortable: false,
      render: (master) => (
        <button
          onClick={() => onEdit(master)}
          style={{ ...BTN.secondary.sm, cursor: 'pointer' }}
        >
          Edit
        </button>
      ),
    },
  ];

  return (
    <div style={{ padding: 10 }}>
      <DataTable
        columns={columns}
        rows={list}
        rowKey={(m) => m.id}
        onRowClick={(m) => onEdit(m)}
        rowStyle={(m) => (highlightId === m.id
          ? { background: '#eff6ff', boxShadow: 'inset 0 0 0 2px #0e7fe0' }
          : undefined)}
        sort={sort}
        onSort={(next) => { setSort(next); setPage(1); }}
        page={page}
        onPage={setPage}
        empty="No scheduled tasks match."
      />
    </div>
  );
}
