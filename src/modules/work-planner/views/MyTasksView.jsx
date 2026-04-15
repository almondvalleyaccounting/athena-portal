import React, { useState } from 'react';
import { STATUSES } from '../lib/constants';
import {
  durFmt, formatDateShort, clientName, today, addDays, addMonths,
} from '../lib/helpers';
import { generateInstances } from '../lib/instanceEngine';
import Avatar from '../components/Avatar';
import DueBadge from '../components/DueBadge';
import StatusIcon from '../components/StatusIcon';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function MyTasksView({ dueFilter, onAction }) {
  const {
    quickTasks, scheduledTasks, overridesMap, completedKeys,
    staffMap, entityMap, profile,
    filters, highlightId, notesMap, addProgressNote,
  } = useWorkPlanner();

  const [noteInput, setNoteInput] = useState(null);
  const [noteText, setNoteText] = useState('');

  const now = today();

  // Determine due cutoff
  let cutoff = addMonths(now, 3); // default
  if (dueFilter === 'today') cutoff = addDays(now, 1);
  else if (dueFilter === 'week') cutoff = addDays(now, 7);
  else if (dueFilter === 'month') cutoff = addMonths(now, 1);
  else if (dueFilter === '3') cutoff = addMonths(now, 3);
  else if (dueFilter === 'all') cutoff = addMonths(now, 24);

  // Build unified task list
  let items = [];

  // Quick tasks
  if (!filters.sourceFilter || filters.sourceFilter === 'quick') {
    quickTasks.forEach((t) => {
      items.push({
        ...t,
        _source: 'quick',
        _isQuick: true,
        _sortDate: t.due_date ? new Date(t.due_date) : (t.planned_date ? new Date(t.planned_date) : new Date('2099-12-31')),
        _noteKey: `quick:${t.id}`,
        _noteTaskType: 'quick',
        _noteTaskId: t.id,
      });
    });
  }

  // Scheduled instances
  if (!filters.sourceFilter || filters.sourceFilter === 'scheduled') {
    scheduledTasks.forEach((m) => {
      const instances = generateInstances(m, now, cutoff, overridesMap, completedKeys);
      instances.forEach((inst) => {
        items.push({
          ...inst,
          _source: 'scheduled',
          _sortDate: inst._date || new Date('2099-12-31'),
          _noteKey: `scheduled:${inst._masterId}`,
          _noteTaskType: 'scheduled',
          _noteTaskId: inst._masterId,
        });
      });
    });
  }

  // Apply filters
  if (filters.teamFilter) items = items.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) items = items.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) items = items.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) items = items.filter((t) => t.status === filters.statusFilter);

  // Apply due cutoff to quick tasks too
  if (dueFilter && dueFilter !== 'all') {
    items = items.filter((t) => {
      if (t._source === 'quick') {
        if (!t.due_date) return true; // no due date = always show
        return new Date(t.due_date) < cutoff;
      }
      return true; // scheduled already filtered by generateInstances range
    });
  }

  // Sort by date ascending
  items.sort((a, b) => a._sortDate.getTime() - b._sortDate.getTime());

  const noteCount = (key) => (notesMap[key] || []).length;

  return (
    <div style={{ padding: 10, maxWidth: 960 }}>
      {items.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: '#cbd5e1', fontSize: 13, fontFamily: "'Outfit', sans-serif" }}>
          No tasks match your filters.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((task) => {
          const isHl = highlightId === task.id;
          const accentColour = task._source === 'quick' ? '#38bdf8' : '#0e7fe0';
          const st = task.status ? STATUSES.find((s) => s.id === task.status) : null;
          const nc = noteCount(task._noteKey);

          return (
            <div
              key={task.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 11px',
                background: isHl ? '#eff6ff' : '#fff',
                border: `1px solid ${isHl ? '#0e7fe0' : '#e5e7eb'}`,
                borderLeft: `3px solid ${accentColour}`,
                borderRadius: 8,
                transition: 'all 0.12s',
                boxShadow: isHl ? '0 0 0 2px #dbeafe' : 'none',
                fontFamily: "'Outfit', sans-serif",
              }}
            >
              {task.assignee_id && <Avatar id={task.assignee_id} staffMap={staffMap} size={22} />}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  onClick={(e) => onAction(e, task)}
                  style={{ fontSize: 13, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  {task.title}
                  {task._source === 'quick' && (
                    <span style={{ padding: '1px 5px', fontSize: 9, borderRadius: 3, background: '#dbeafe', color: '#0e7fe0', fontWeight: 500 }}>
                      quick
                    </span>
                  )}
                  {task.recurring && (
                    <span style={{ padding: '1px 5px', fontSize: 9, borderRadius: 3, background: '#dbeafe', color: '#0e7fe0', fontWeight: 500 }}>
                      {task.recurrence}
                    </span>
                  )}
                  {task._hasOverride && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                  )}
                </div>

                <div style={{ fontSize: 11, color: '#64748b', marginTop: 1, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  {task.entity_id && <span>{clientName(task.entity_id, entityMap)}</span>}
                  {task.service && <span style={{ color: '#94a3b8' }}>{task.service}</span>}
                  {st && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 2,
                      padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 500,
                      background: st.colour + '14', color: st.colour,
                    }}>
                      <span style={{ width: 4, height: 4, borderRadius: '50%', background: st.colour }} />
                      {st.label}
                    </span>
                  )}
                  {task._source === 'quick' && task.due_date && <DueBadge date={task.due_date} />}
                  {task._source === 'scheduled' && task._date && (
                    <span style={{ fontSize: 10, color: '#64748b' }}>Due: {formatDateShort(task._date)}</span>
                  )}
                  {task.duration && <span style={{ fontSize: 10, color: '#94a3b8' }}>{durFmt(task.duration)}</span>}
                  {nc > 0 && (
                    <span style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 3, fontSize: 9, color: '#64748b', fontWeight: 600 }}>
                      {nc} note{nc !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Progress notes thread */}
                {(() => {
                  const notes = notesMap[task._noteKey] || [];
                  return notes.length > 0 ? (
                    <div style={{ marginTop: 4, borderLeft: '2px solid #e5e7eb', paddingLeft: 6 }}>
                      {notes.map((n) => (
                        <div key={n.id} style={{ fontSize: 11, color: '#1e293b', lineHeight: 1.4, marginBottom: 2 }}>
                          <span>{n.note}</span>
                          <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 9 }}>
                            {(n.created_by_name || '').split(' ')[0]} &middot; {timeAgo(n.created_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}

                {/* Add note */}
                {noteInput === task.id ? (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'flex-start' }}>
                    <input
                      autoFocus
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && noteText.trim()) {
                          await addProgressNote(task._noteTaskType, task._noteTaskId, noteText.trim());
                          setNoteText(''); setNoteInput(null);
                        }
                        if (e.key === 'Escape') { setNoteInput(null); setNoteText(''); }
                      }}
                      placeholder="Progress note..."
                      style={{
                        flex: 1, padding: '4px 8px', fontSize: 12,
                        fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                        borderRadius: 6, outline: 'none',
                      }}
                    />
                    <button
                      onClick={async () => {
                        if (noteText.trim()) await addProgressNote(task._noteTaskType, task._noteTaskId, noteText.trim());
                        setNoteText(''); setNoteInput(null);
                      }}
                      style={{
                        border: 'none', background: '#0e7fe0', color: '#fff',
                        fontSize: 11, fontWeight: 600, padding: '4px 10px',
                        borderRadius: 6, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                      }}
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setNoteInput(task.id); setNoteText(''); }}
                    style={{
                      border: '1px solid #e5e7eb', background: '#f8fafc', color: '#64748b',
                      fontSize: 11, fontWeight: 500, cursor: 'pointer',
                      padding: '3px 10px', marginTop: 4, borderRadius: 6,
                      fontFamily: "'Outfit', sans-serif",
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#dbeafe'; e.currentTarget.style.color = '#0e7fe0'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#f8fafc'; e.currentTarget.style.color = '#64748b'; }}
                  >
                    + Add note
                  </button>
                )}
              </div>

              {/* Action button */}
              <div style={{ flexShrink: 0, marginTop: 1 }}>
                <button
                  onClick={(e) => onAction(e, task)}
                  title="Actions"
                  style={{
                    padding: '3px 8px', fontSize: 10, fontWeight: 500,
                    border: '1px solid #0e7fe0', borderRadius: 4,
                    background: '#dbeafe', color: '#0e7fe0', cursor: 'pointer',
                    fontFamily: "'Outfit', sans-serif",
                  }}
                >
                  &#10003;
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
