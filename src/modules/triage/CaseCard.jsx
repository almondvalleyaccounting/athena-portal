import React from 'react';
import { CheckCircle2, CalendarDays } from 'lucide-react';
import {
  CATEGORY_MAP, STAGE_MAP, PRIORITY_MAP, ACTION_TYPE_MAP, iconBtn, chip,
  fmtDate, fmtDateShort, nextOpenAction, isOverdueAction, daysOpen, caseHeadline,
} from './triageShared';

// One triage case as a tile. Used by the board (lanes by type) and the Kanban
// (columns by stage). `badge` says which of the two the tile should label —
// on the board the lane already says the type, so the tile shows its stage,
// and vice versa. `compact` is the one-line version for long columns.
export default function CaseCard({
  c, notes = [], actions = [], staffMap, compact, badge, onOpen, onResolve, resolveLabel, dragProps,
}) {
  const cat = CATEGORY_MAP[c.category] || CATEGORY_MAP.general;
  const stage = STAGE_MAP[c.stage] || STAGE_MAP.not_started;
  const resolved = c.status === 'resolved';
  const accent = resolved ? '#cbd5e1' : cat.tone.fg;
  const badgeTone = badge === 'stage' ? stage.tone : cat.tone;
  const badgeText = badge === 'stage' ? stage.label : cat.short;
  const assignee = c.assignee_id && staffMap[c.assignee_id];
  const priority = c.priority && PRIORITY_MAP[c.priority];

  const {
    setNodeRef, style: dragStyle, listeners, attributes,
  } = dragProps || {};

  const frame = {
    border: `1px solid ${resolved ? '#e5e7eb' : cat.tone.border}`,
    borderLeft: `3px solid ${accent}`,
    borderRadius: compact ? 8 : 10,
    padding: compact ? '6px 9px' : '10px 12px',
    cursor: dragProps ? 'grab' : 'pointer',
    background: resolved ? '#f8fafc' : '#fff',
    opacity: resolved ? 0.75 : 1,
    ...(dragStyle || {}),
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: compact ? 13.5 : 14.5, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {caseHeadline(c)}
      </span>
      {badge && <span style={chip(badgeTone)}>{badgeText}</span>}
      {resolved && <CheckCircle2 size={13} color="#16a34a" />}
      <span style={{ fontSize: 11.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>{daysOpen(c.created_at)}d</span>
      {!resolved && onResolve && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onResolve(c); }}
          title={resolveLabel}
          aria-label={resolveLabel}
          style={{ ...iconBtn, padding: '2px 4px', borderColor: '#e2e8f0', color: '#94a3b8' }}
        >
          <CheckCircle2 size={12} />
        </button>
      )}
    </div>
  );

  if (compact) {
    return (
      <div ref={setNodeRef} {...(listeners || {})} {...(attributes || {})} onClick={() => onOpen(c)} style={frame}>
        {header}
      </div>
    );
  }

  const overdue = c.target_date && c.target_date < new Date().toISOString().slice(0, 10);
  const activeActs = actions.filter((a) => a.status !== 'cancelled');
  const doneActs = activeActs.filter((a) => a.status === 'done').length;
  const nextAct = nextOpenAction(actions);
  const NextIcon = nextAct ? (ACTION_TYPE_MAP[nextAct.action_type] || ACTION_TYPE_MAP.other).icon : null;

  return (
    <div ref={setNodeRef} {...(listeners || {})} {...(attributes || {})} onClick={() => onOpen(c)} style={frame}>
      {header}
      {c.title && (
        <div style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.title}
        </div>
      )}
      <div style={{ fontSize: 13, color: '#64748b', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {c.description}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: '#94a3b8', flexWrap: 'wrap' }}>
        {nextAct ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569', minWidth: 0 }}>
            <NextIcon size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
              Next: {nextAct.title}
            </span>
            {nextAct.target_date && (
              <span style={{ color: isOverdueAction(nextAct) ? '#dc2626' : '#94a3b8', whiteSpace: 'nowrap' }}>
                · {fmtDateShort(nextAct.target_date)}
              </span>
            )}
          </span>
        ) : actions.length === 0 && c.next_action ? (
          <span style={{ color: '#475569' }}>Next: {c.next_action}</span>
        ) : null}
        {activeActs.length > 0 && (
          <span>{doneActs}/{activeActs.length} action{activeActs.length === 1 ? '' : 's'} done</span>
        )}
        {c.target_date && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: overdue ? '#dc2626' : '#94a3b8' }}>
            <CalendarDays size={11} /> {fmtDate(c.target_date)}
          </span>
        )}
        {assignee && <span style={{ color: '#475569' }}>{assignee.split(' ')[0]}</span>}
        {priority && <span style={{ color: priority.fg, fontWeight: 600 }}>{priority.label}</span>}
        {notes.length > 0 && <span>{notes.length} note{notes.length === 1 ? '' : 's'}</span>}
      </div>
    </div>
  );
}
