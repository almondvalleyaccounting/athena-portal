import React from 'react';
import { durFmt, formatDateShort, clientName, staffName } from '../lib/helpers';
import Avatar from '../components/Avatar';
import { useWorkPlanner } from '../WorkPlannerModule';

export default function CompletedView() {
  const { completedTasks, staffMap, entityMap, filters } = useWorkPlanner();

  let list = [...completedTasks];
  if (filters.teamFilter) list = list.filter((t) => t.assignee_id === filters.teamFilter);
  if (filters.clientFilter) list = list.filter((t) => t.entity_id === filters.clientFilter);
  if (filters.serviceFilter) list = list.filter((t) => t.service === filters.serviceFilter);
  // Already ordered by completed_at desc from DB

  return (
    <div style={{ padding: '12px 20px', maxWidth: 960 }}>
      {list.map((task) => (
        <div
          key={task.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 11px', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            marginBottom: 3, opacity: 0.6,
            transition: 'opacity 0.15s',
            fontFamily: "'Outfit', sans-serif",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
        >
          {task.assignee_id ? (
            <Avatar id={task.assignee_id} staffMap={staffMap} size={20} />
          ) : (
            <div style={{
              width: 20, height: 20, borderRadius: '50%',
              background: '#cbd5e1', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 8, fontWeight: 600, color: '#fff',
            }}>
              ?
            </div>
          )}

          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 12, fontWeight: 500, color: '#64748b',
              textDecoration: task.not_required ? 'none' : 'line-through',
            }}>
              {task.title}
              {task.not_required && (
                <span style={{ fontSize: 9, color: '#94a3b8', fontStyle: 'italic', marginLeft: 4 }}>
                  not required
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8' }}>
              {task.entity_id ? clientName(task.entity_id, entityMap) + ' \u00B7 ' : ''}
              {task.service || ''}
              {' \u00B7 '}
              {task.source_type === 'quick' ? 'Quick' : 'Scheduled'}
            </div>
          </div>

          {task.completion_mins ? (
            <div style={{ fontSize: 10, color: '#0e7fe0', fontWeight: 500 }}>
              {durFmt(task.completion_mins)}
            </div>
          ) : null}

          <div style={{ fontSize: 9, color: '#94a3b8' }}>
            {task.completed_at ? formatDateShort(task.completed_at) : ''}
          </div>
        </div>
      ))}

      {list.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: '#cbd5e1', fontSize: 11 }}>
          No completed tasks.
        </div>
      )}
    </div>
  );
}
