import React, { useState } from 'react';
import { SOURCES } from '../lib/constants';
import { durFmt, formatDateShort, clientName, staffFirstName, getStatus } from '../lib/helpers';
import { nextInstance } from '../lib/instanceEngine';
import Avatar from '../components/Avatar';
import StatusIcon from '../components/StatusIcon';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function ScheduledView({ sort, onEdit }) {
  const {
    scheduledTasks, overridesMap, completedKeys, staffMap, entityMap,
    filters, highlightId, notesMap, addProgressNote,
  } = useWorkPlanner();

  const [noteInput, setNoteInput] = useState(null);
  const [noteText, setNoteText] = useState('');

  // Filter
  let list = [...scheduledTasks];
  if (filters.teamFilter) list = list.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) list = list.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) list = list.filter((t) => t.service === filters.serviceFilter);
  if (filters.statusFilter) list = list.filter((t) => t.status === filters.statusFilter);

  // Sort
  list.sort((a, b) => {
    if (sort === 'client') return (clientName(a.entity_id, entityMap) || 'zzz').localeCompare(clientName(b.entity_id, entityMap) || 'zzz');
    if (sort === 'service') return (a.service || 'zzz').localeCompare(b.service || 'zzz');
    if (sort === 'owner') return staffFirstName(a.assignee_id, staffMap).localeCompare(staffFirstName(b.assignee_id, staffMap));
    if (sort === 'next') {
      const na = nextInstance(a, overridesMap, completedKeys);
      const nb = nextInstance(b, overridesMap, completedKeys);
      return (na ? na._date.getTime() : 9e12) - (nb ? nb._date.getTime() : 9e12);
    }
    return a.title.localeCompare(b.title);
  });

  return (
    <div style={{ padding: 10, maxWidth: 960 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {list.map((master) => {
          const ni = nextInstance(master, overridesMap, completedKeys);
          const st = ni ? getStatus(ni.status) : null;
          const displayAssignee = ni ? ni.assignee_id : master.assignee_id;
          const src = SOURCES.find((s) => s.id === master.source);
          const isHl = highlightId === master.id;

          const srcStyle = master.source === 'brightmanager'
            ? { color: '#15803d', background: '#f0fdf4' }
            : master.source === 'payroll_checklist'
            ? { color: '#a16207', background: '#fefce8' }
            : { color: '#64748b', background: '#f1f5f9' };

          return (
            <div
              key={master.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 11px', background: isHl ? '#eff6ff' : '#fff',
                border: `1px solid ${isHl ? '#0e7fe0' : '#e5e7eb'}`,
                borderRadius: 8, transition: 'all 0.12s',
                boxShadow: isHl ? '0 0 0 2px #dbeafe' : 'none',
              }}
            >
              {displayAssignee && <Avatar id={displayAssignee} staffMap={staffMap} />}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  onClick={() => onEdit(master)}
                  style={{ fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  {master.title}
                  {master.recurring && (
                    <span style={{
                      padding: '1px 5px', fontSize: 10, borderRadius: 3,
                      background: '#dbeafe', color: '#0e7fe0', fontWeight: 500,
                    }}>
                      {master.recurrence}
                    </span>
                  )}
                  {ni && ni._hasOverride && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                  )}
                </div>

                <div style={{ fontSize: 12, color: '#64748b', marginTop: 1, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  {master.entity_id && <span onClick={(e) => { e.stopPropagation(); window.location.href = `/clients/${master.entity_id}`; }} style={{ cursor: 'pointer', color: '#0e7fe0' }} onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'} onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}>{clientName(master.entity_id, entityMap)}</span>}
                  {master.service && <span style={{ color: '#94a3b8' }}>{master.service}</span>}
                  <span style={{
                    padding: '1px 5px', fontSize: 10, borderRadius: 3, fontWeight: 500, ...srcStyle,
                  }}>
                    {src ? src.label : master.source}
                  </span>
                  {st && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                      padding: '2px 7px', borderRadius: 12, fontSize: 11, fontWeight: 500,
                      background: st.colour + '14', color: st.colour,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: st.colour }} />
                      {st.label}
                    </span>
                  )}
                  {ni ? (
                    <span style={{ fontSize: 11, color: '#64748b' }}>Next: {formatDateShort(ni._date)}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#cbd5e1' }}>No upcoming</span>
                  )}
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{durFmt(master.duration)}</span>
                  {(notesMap[`scheduled:${master.id}`] || []).length > 0 && (
                    <span style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 3, fontSize: 9, color: '#64748b', fontWeight: 600 }}>
                      {(notesMap[`scheduled:${master.id}`] || []).length} note{(notesMap[`scheduled:${master.id}`] || []).length !== 1 ? 's' : ''}
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
                        flex: 1, padding: '3px 6px', fontSize: 11,
                        fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
                        borderRadius: 3, outline: 'none',
                      }}
                    />
                    <button
                      onClick={async () => {
                        if (noteText.trim()) await addProgressNote('scheduled', master.id, noteText.trim());
                        setNoteText(''); setNoteInput(null);
                      }}
                      style={{
                        border: 'none', background: '#0e7fe0', color: '#fff',
                        fontSize: 10, fontWeight: 600, padding: '3px 8px',
                        borderRadius: 3, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                      }}
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setNoteInput(master.id); setNoteText(''); }}
                    style={{
                      border: '1px solid #e5e7eb', background: '#f8fafc', color: '#64748b',
                      fontSize: 10, fontWeight: 500, cursor: 'pointer',
                      padding: '3px 10px', marginTop: 3, borderRadius: 6,
                      fontFamily: "'Outfit', sans-serif",
                    }}
                  >
                    + Add note
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 3, flexShrink: 0, marginTop: 1, alignItems: 'center' }}>
                <button
                  onClick={() => onEdit(master)}
                  style={{
                    padding: '2px 6px', fontSize: 11, fontWeight: 500,
                    border: '1px solid #e5e7eb', borderRadius: 3,
                    background: '#fff', color: '#0e7fe0', cursor: 'pointer',
                    fontFamily: "'Outfit', sans-serif",
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
          );
        })}

        {list.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center', color: '#cbd5e1', fontSize: 13 }}>
            No scheduled tasks match.
          </div>
        )}
      </div>
    </div>
  );
}
