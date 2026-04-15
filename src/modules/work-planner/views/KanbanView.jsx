import React, { useState, useRef, useCallback } from 'react';
import { STATUSES } from '../lib/constants';
import { durFmt, formatDateShort, clientName, addDays, addMonths, today, dueBadge } from '../lib/helpers';
import { generateInstances } from '../lib/instanceEngine';
import Avatar from '../components/Avatar';
import DueBadge from '../components/DueBadge';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function KanbanView({ dueFilter, onAction }) {
  const {
    scheduledTasks, overridesMap, completedKeys, staffMap, entityMap,
    quickTasks, filters, highlightId, saveOverride, notesMap, addProgressNote,
  } = useWorkPlanner();

  const [noteInput, setNoteInput] = useState(null); // task key with open input
  const [noteText, setNoteText] = useState('');

  const [dragCol, setDragCol] = useState(null);
  const dragRef = useRef(null);

  const now = today();
  const to = addMonths(now, 12);

  // Generate all instances
  let allInstances = [];
  scheduledTasks.forEach((m) => {
    allInstances = allInstances.concat(generateInstances(m, now, to, overridesMap, completedKeys));
  });

  // Apply filters
  if (filters.teamFilter) allInstances = allInstances.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) allInstances = allInstances.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) allInstances = allInstances.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) allInstances = allInstances.filter((t) => t.status === filters.statusFilter);

  // Apply due filter
  if (dueFilter && dueFilter !== 'all') {
    let cutoff;
    if (dueFilter === 'today') cutoff = addDays(now, 1);
    else if (dueFilter === 'week') cutoff = addDays(now, 7);
    else if (dueFilter === 'month') cutoff = addMonths(now, 1);
    else {
      const months = parseInt(dueFilter);
      if (!isNaN(months)) cutoff = addMonths(now, months);
    }
    if (cutoff) allInstances = allInstances.filter((t) => new Date(t.planned_date) < cutoff);
  }

  function handleDrop(colId) {
    if (!dragRef.current) return;
    const inst = dragRef.current;
    saveOverride(inst._masterId, inst._date, { status: colId });
    dragRef.current = null;
    setDragCol(null);
  }

  // Quick tasks filtered
  let quickFiltered = [...quickTasks];
  if (filters.teamFilter) quickFiltered = quickFiltered.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) quickFiltered = quickFiltered.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) quickFiltered = quickFiltered.filter((t) => t.service === filters.serviceFilter);
  quickFiltered.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  return (
    <div style={{ display: 'flex', gap: 10, padding: 10, height: '100%', overflowX: 'auto' }}>
      {/* Quick Tasks column */}
      <div
        style={{
          flex: 1, minWidth: 175, maxWidth: 240,
          display: 'flex', flexDirection: 'column',
          background: '#f8fafc', borderRadius: 10,
          border: '1px solid #e5e7eb', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 10, borderBottom: '1px solid #e5e7eb', background: '#fff',
        }}>
          <div style={{
            fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5,
            fontFamily: "'Outfit', sans-serif",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#38bdf8' }} />
            Quick Tasks
          </div>
          <span style={{
            fontSize: 11, color: '#94a3b8', padding: '1px 5px',
            borderRadius: 6, border: '1px solid #f1f5f9',
          }}>
            {quickFiltered.length}
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 5 }}>
          {quickFiltered.map((task) => {
            const isHl = highlightId === task.id;
            return (
              <div
                key={task.id}
                onClick={(e) => onAction(e, { ...task, _isQuick: true })}
                style={{
                  padding: '7px 9px', background: '#fff',
                  border: `1px solid ${isHl ? '#0e7fe0' : '#e5e7eb'}`,
                  borderLeft: '3px solid #38bdf8',
                  borderRadius: 6, marginBottom: 5, cursor: 'pointer',
                  transition: 'all 0.12s',
                  boxShadow: isHl ? '0 0 0 2px #dbeafe' : 'none',
                  fontFamily: "'Outfit', sans-serif",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 2 }}>
                  {task.title}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  {task.assignee_id && <Avatar id={task.assignee_id} staffMap={staffMap} size={18} />}
                  {task.entity_id && <span onClick={(e) => { e.stopPropagation(); window.location.href = `/clients/${task.entity_id}`; }} style={{ cursor: 'pointer', color: '#0e7fe0' }} onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'} onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}>{clientName(task.entity_id, entityMap)}</span>}
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {task.service}
                  {task.due_date && (
                    <>
                      <span>&middot;</span>
                      <DueBadge date={task.due_date} />
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {quickFiltered.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: '#cbd5e1', textAlign: 'center' }}>
              No quick tasks
            </div>
          )}
        </div>
      </div>

      {/* Status columns */}
      {STATUSES.map((col) => {
        const items = allInstances.filter((t) => t.status === col.id);
        const isDropTarget = dragCol === col.id;

        return (
          <div
            key={col.id}
            style={{
              flex: 1, minWidth: 175, maxWidth: 240,
              display: 'flex', flexDirection: 'column',
              background: '#f8fafc', borderRadius: 10,
              border: '1px solid #e5e7eb', overflow: 'hidden',
            }}
          >
            {/* Column header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: 10, borderBottom: '1px solid #e5e7eb', background: '#fff',
            }}>
              <div style={{
                fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5,
                fontFamily: "'Outfit', sans-serif",
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: col.colour }} />
                {col.label}
              </div>
              <span style={{
                fontSize: 11, color: '#94a3b8', padding: '1px 5px',
                borderRadius: 6, border: '1px solid #f1f5f9',
              }}>
                {items.length}
              </span>
            </div>

            {/* Column body */}
            <div
              style={{
                flex: 1, overflowY: 'auto', padding: 5,
                background: isDropTarget ? '#eff6ff' : undefined,
                transition: 'background 0.15s',
              }}
              onDragOver={(e) => { e.preventDefault(); setDragCol(col.id); }}
              onDragLeave={() => setDragCol(null)}
              onDrop={(e) => { e.preventDefault(); handleDrop(col.id); }}
            >
              {items.map((inst) => {
                const isHl = highlightId === inst.id;
                return (
                  <div
                    key={inst.id}
                    draggable
                    onDragStart={() => { dragRef.current = inst; }}
                    onClick={(e) => onAction(e, inst)}
                    style={{
                      padding: '7px 9px', background: '#fff',
                      border: `1px solid ${isHl ? '#0e7fe0' : '#e5e7eb'}`,
                      borderRadius: 6, marginBottom: 5, cursor: 'grab',
                      transition: 'all 0.12s',
                      boxShadow: isHl ? '0 0 0 2px #dbeafe' : 'none',
                      fontFamily: "'Outfit', sans-serif",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 500, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {inst.title}
                      {inst._hasOverride && (
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {inst.assignee_id && <Avatar id={inst.assignee_id} staffMap={staffMap} size={18} />}
                      {inst.entity_id && <span>{clientName(inst.entity_id, entityMap)}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {formatDateShort(inst._date)} &middot; {durFmt(inst.duration)}
                      {(notesMap[`scheduled:${inst._masterId}`] || []).length > 0 && (
                        <span style={{
                          background: '#f1f5f9', padding: '0 4px', borderRadius: 3,
                          fontSize: 8, color: '#64748b', fontWeight: 600,
                        }}>
                          {(notesMap[`scheduled:${inst._masterId}`] || []).length} note{(notesMap[`scheduled:${inst._masterId}`] || []).length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {noteInput === inst._key ? (
                      <div style={{ display: 'flex', gap: 3, marginTop: 3 }} onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && noteText.trim()) {
                              await addProgressNote('scheduled', inst._masterId, noteText.trim());
                              setNoteText(''); setNoteInput(null);
                            }
                            if (e.key === 'Escape') { setNoteInput(null); setNoteText(''); }
                          }}
                          placeholder="Note..."
                          style={{
                            flex: 1, padding: '2px 5px', fontSize: 10,
                            fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                            borderRadius: 3, outline: 'none', minWidth: 0,
                          }}
                        />
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (noteText.trim()) await addProgressNote('scheduled', inst._masterId, noteText.trim());
                            setNoteText(''); setNoteInput(null);
                          }}
                          style={{
                            border: 'none', background: '#0e7fe0', color: '#fff',
                            fontSize: 9, fontWeight: 600, padding: '2px 6px',
                            borderRadius: 3, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                          }}
                        >
                          Add
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setNoteInput(inst._key); setNoteText(''); }}
                        style={{
                          border: 'none', background: 'none', color: '#94a3b8',
                          fontSize: 9, cursor: 'pointer', padding: '2px 0', marginTop: 2,
                          fontFamily: "'Outfit', sans-serif",
                        }}
                      >
                        +note
                      </button>
                    )}
                  </div>
                );
              })}
              {items.length === 0 && (
                <div style={{ padding: 14, fontSize: 12, color: '#cbd5e1', textAlign: 'center' }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
