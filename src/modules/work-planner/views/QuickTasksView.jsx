import React, { useState, useCallback } from 'react';
import { SERVICES } from '../lib/constants';
import { clientName, formatISO, addDays, today, formatDateShort, sameDay } from '../lib/helpers';
import Avatar from '../components/Avatar';
import DueBadge from '../components/DueBadge';
import ClientTypeAhead from '../components/ClientTypeAhead';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function QuickTasksView({ compact, onAction }) {
  const {
    quickTasks, staffList, entityList, staffMap, entityMap,
    addQuickTask, updateQuickTask, reorderQuickTasks, filters,
    highlightId, profile, addEntity, notesMap, addProgressNote, staffColours,
  } = useWorkPlanner();

  const [title, setTitle] = useState('');
  const [clientId, setClientId] = useState('');
  const [service, setService] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [expandedNote, setExpandedNote] = useState(null);
  const [progressInput, setProgressInput] = useState(null);
  const [progressText, setProgressText] = useState('');
  const [dragId, setDragId] = useState(null);

  const now = today();

  const canAdd = title.trim() && clientId && service && assigneeId;

  async function handleAdd() {
    if (!canAdd) return;
    await addQuickTask({
      title: title.trim(),
      entity_id: clientId || null,
      service,
      assignee_id: assigneeId || null,
      due_date: addDays(now, 5).toISOString(),
      planned_date: null,
      duration: 15,
      notes: '',
      sort_order: 0,
      created_by: profile.id,
    });
    setTitle('');
  }

  // Filter
  let list = [...quickTasks];
  if (filters.teamFilter) list = list.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) list = list.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) list = list.filter((t) => t.service === filters.serviceFilter);
  list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) return;
    const ids = list.map((t) => t.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    reorderQuickTasks(ids);
    setDragId(null);
  }

  const inputStyle = {
    padding: '8px 12px', fontSize: 14, fontFamily: "'Outfit', sans-serif",
    border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
    color: '#0f172a', outline: 'none', flex: 1, minWidth: 200,
  };
  const selectStyle = {
    padding: '4px 8px', fontSize: 12, fontFamily: "'Outfit', sans-serif",
    border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
    color: '#1e293b', outline: 'none',
  };

  return (
    <div style={{ padding: 10, maxWidth: 960 }}>
      {/* Add bar */}
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={inputStyle}
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
        />
        <ClientTypeAhead
          entityList={entityList}
          value={clientId}
          onChange={setClientId}
          onAddNew={addEntity}
          size="small"
        />
        <select style={selectStyle} value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Service</option>
          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={selectStyle} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Assign</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>{(s.name || '').split(' ')[0]}</option>
          ))}
        </select>
        <button
          onClick={handleAdd}
          disabled={!canAdd}
          style={{
            padding: '6px 14px', fontSize: 13, fontWeight: 500,
            fontFamily: "'Outfit', sans-serif",
            border: canAdd ? '1px solid #0f172a' : '1px solid #e5e7eb',
            borderRadius: 8,
            background: canAdd ? '#0f172a' : '#f1f5f9',
            color: canAdd ? '#fff' : '#94a3b8',
            cursor: canAdd ? 'pointer' : 'default',
            transition: 'all 0.15s',
          }}
        >
          Add
        </button>
      </div>

      {/* Task list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {list.map((task) => {
          const isPlanned = task.planned_date && new Date(task.planned_date) >= now;
          const isDrag = dragId === task.id;
          const isHl = highlightId === task.id;
          const isExpNote = expandedNote === task.id;

          return (
            <div
              key={task.id}
              style={{
                display: 'flex',
                alignItems: compact ? 'center' : 'flex-start',
                gap: compact ? 5 : 8,
                padding: compact ? '3px 10px' : '8px 11px',
                background: isHl ? '#eff6ff' : '#fff',
                border: task._overdue ? '2px solid #f59e0b' : `1px solid ${isHl ? '#0e7fe0' : '#e5e7eb'}`,
                borderLeft: task._overdue ? '3px solid #f59e0b' : undefined,
                borderRadius: 8,
                transition: 'all 0.12s',
                opacity: isDrag ? 0.25 : 1,
                boxShadow: task._overdue ? '0 0 0 1px #f59e0b' : isHl ? '0 0 0 2px #dbeafe' : 'none',
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleDrop(task.id); }}
            >
              {/* Drag grip */}
              <span
                draggable
                onDragStart={() => setDragId(task.id)}
                onDragEnd={() => setDragId(null)}
                style={{ cursor: 'grab', color: '#cbd5e1', fontSize: 12, userSelect: 'none', flexShrink: 0, marginTop: compact ? 0 : 1 }}
              >
                &#9776;
              </span>

              {/* Avatar */}
              {task.assignee_id && <Avatar id={task.assignee_id} staffMap={staffMap} size={compact ? 18 : 22} customColour={staffColours?.[task.assignee_id]} />}

              {/* Body */}
              <div style={{ flex: 1, minWidth: 0, display: compact ? 'flex' : 'block', alignItems: 'center', gap: compact ? 8 : 0 }}>
                <div
                  onClick={(e) => onAction(e, task)}
                  style={{ fontSize: compact ? 12 : 14, fontWeight: 500, cursor: 'pointer' }}
                >
                  {task.title}
                </div>
                <div style={{
                  fontSize: compact ? 11 : 12, color: '#64748b',
                  marginTop: compact ? 0 : 1,
                  display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap',
                }}>
                  {task.entity_id && <span onClick={(e) => { e.stopPropagation(); window.location.href = `/clients/${task.entity_id}`; }} style={{ cursor: 'pointer', color: '#0e7fe0', textDecoration: 'none' }} onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'} onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}>{clientName(task.entity_id, entityMap)}</span>}
                  <span style={{ color: '#94a3b8' }}>{task.service}</span>
                  <DueBadge date={task.due_date} />
                  {isPlanned && (
                    <span style={{ color: '#0e7fe0', fontSize: 9 }}>
                      &#128197; {formatDateShort(task.planned_date)}
                    </span>
                  )}
                </div>

                {/* Inline note (legacy field) */}
                {!compact && task.notes && task.notes.trim() && !isExpNote && (
                  <div
                    onClick={() => setExpandedNote(task.id)}
                    style={{
                      fontSize: 10, color: '#1e293b', marginTop: 3,
                      padding: '3px 6px', background: '#f1f5f9', borderRadius: 3,
                      lineHeight: 1.3, cursor: 'pointer', maxHeight: 32, overflow: 'hidden',
                    }}
                  >
                    {task.notes.trim()}
                  </div>
                )}
                {!compact && isExpNote && (
                  <textarea
                    value={task.notes}
                    onChange={(e) => updateQuickTask(task.id, { notes: e.target.value })}
                    onBlur={() => setExpandedNote(null)}
                    autoFocus
                    style={{
                      width: '100%', padding: '4px 6px', fontSize: 10,
                      fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                      borderRadius: 3, background: '#fff', color: '#1e293b',
                      outline: 'none', resize: 'vertical', minHeight: 24, marginTop: 3,
                    }}
                  />
                )}

                {/* Progress notes thread */}
                {!compact && (() => {
                  const notes = notesMap[`quick:${task.id}`] || [];
                  const isAddingNote = progressInput === task.id;
                  return (
                    <>
                      {notes.length > 0 && (
                        <div style={{ marginTop: 4, borderLeft: '2px solid #e5e7eb', paddingLeft: 6 }}>
                          {notes.map((n) => (
                            <div key={n.id} style={{ fontSize: 10, color: '#1e293b', lineHeight: 1.4, marginBottom: 2 }}>
                              <span>{n.note}</span>
                              <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 9 }}>
                                {(n.created_by_name || '').split(' ')[0]} &middot; {timeAgo(n.created_at)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {isAddingNote ? (
                        <div style={{ display: 'flex', gap: 4, marginTop: 3, alignItems: 'flex-start' }}>
                          <input
                            autoFocus
                            value={progressText}
                            onChange={(e) => setProgressText(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && progressText.trim()) {
                                await addProgressNote('quick', task.id, progressText.trim());
                                setProgressText('');
                                setProgressInput(null);
                              }
                              if (e.key === 'Escape') { setProgressInput(null); setProgressText(''); }
                            }}
                            placeholder="Progress note..."
                            style={{
                              flex: 1, padding: '3px 6px', fontSize: 10,
                              fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                              borderRadius: 3, background: '#fff', color: '#1e293b', outline: 'none',
                            }}
                          />
                          <button
                            onClick={async () => {
                              if (progressText.trim()) {
                                await addProgressNote('quick', task.id, progressText.trim());
                                setProgressText('');
                              }
                              setProgressInput(null);
                            }}
                            style={{
                              border: 'none', background: '#0e7fe0', color: '#fff',
                              fontSize: 9, fontWeight: 600, padding: '3px 8px',
                              borderRadius: 3, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                            }}
                          >
                            Add
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setProgressInput(task.id); setProgressText(''); }}
                          style={{
                            border: '1px solid #e5e7eb', background: '#f8fafc', color: '#64748b',
                            fontSize: 10, fontWeight: 500, cursor: 'pointer',
                            padding: '2px 8px', marginTop: notes.length > 0 ? 2 : 3, borderRadius: 5,
                            fontFamily: "'Outfit', sans-serif",
                          }}
                        >
                          + Add note
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 3, flexShrink: 0, marginTop: compact ? 0 : 1, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={(e) => onAction(e, task)}
                  title="Complete"
                  style={{
                    padding: '2px 6px', fontSize: 9, fontWeight: 500,
                    border: '1px solid #0e7fe0', borderRadius: 3,
                    background: '#dbeafe', color: '#0e7fe0', cursor: 'pointer',
                    fontFamily: "'Outfit', sans-serif",
                  }}
                >
                  &#10003;
                </button>
                <input
                  type="date"
                  style={{ ...selectStyle, width: 95, fontSize: 9, padding: '1px 3px' }}
                  value={task.due_date ? formatISO(new Date(task.due_date)) : ''}
                  onChange={(e) => {
                    updateQuickTask(task.id, {
                      due_date: e.target.value ? new Date(e.target.value + 'T00:00:00').toISOString() : null,
                    });
                  }}
                />
                <button
                  style={miniBtn}
                  onClick={() => updateQuickTask(task.id, { due_date: new Date().toISOString() })}
                >
                  Today
                </button>
                <button
                  style={miniBtn}
                  onClick={() => updateQuickTask(task.id, { due_date: addDays(new Date(), 1).toISOString() })}
                >
                  Tmrw
                </button>
                {isPlanned && (
                  <button
                    style={miniBtn}
                    onClick={() => updateQuickTask(task.id, { planned_date: null })}
                  >
                    Unplan
                  </button>
                )}
                <button
                  style={{ ...miniBtn, color: '#0f172a', fontWeight: 600 }}
                  onClick={() => {
                    // Promote handled by parent
                    onAction(null, { ...task, _promote: true });
                  }}
                >
                  Promote&#8599;
                </button>
              </div>
            </div>
          );
        })}

        {list.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>
            No quick tasks. Type above to add one.
          </div>
        )}
      </div>
    </div>
  );
}

const miniBtn = {
  padding: '3px 8px', fontSize: 11, fontWeight: 500,
  border: '1px solid #e5e7eb', borderRadius: 4,
  background: '#fff', color: '#0e7fe0', cursor: 'pointer',
  fontFamily: "'Outfit', sans-serif", whiteSpace: 'nowrap',
};

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
