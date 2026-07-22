import React from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core';
import { Star, MapPin, Mail, StickyNote } from 'lucide-react';
import { STAGES, STAGE_MAP, daysSince, font } from '../recruitmentShared';

// The pipeline kanban. Five stage columns; drag a card between columns to
// change its stage (persisted by the parent via onMove). Cards open the
// application drawer on click — a small drag activation distance keeps
// clicking and dragging apart.

function Rating({ value }) {
  if (!value) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={10} fill={i < value ? '#f59e0b' : 'none'} color={i < value ? '#f59e0b' : '#cbd5e1'} />
      ))}
    </span>
  );
}

function candidateName(app) {
  return app.candidate?.full_name || 'Candidate (restricted)';
}

function Card({ app, staffMap, onOpen, dragging }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: app.id });
  const style = {
    border: '1px solid #e5e7eb', borderLeft: `3px solid ${(STAGE_MAP[app.stage]?.tone.fg) || '#cbd5e1'}`,
    borderRadius: 10, padding: '9px 11px', background: '#fff', cursor: 'grab',
    boxShadow: isDragging ? '0 10px 30px rgba(15,23,42,0.18)' : 'none',
    opacity: isDragging && !dragging ? 0.4 : 1,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
  };
  return (
    <div
      ref={setNodeRef} style={style} {...listeners} {...attributes}
      onClick={() => onOpen(app)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {candidateName(app)}
        </span>
        <span style={{ fontSize: 10.5, color: '#94a3b8', whiteSpace: 'nowrap' }}>{daysSince(app.applied_at)}d</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, fontSize: 11, color: '#94a3b8', flexWrap: 'wrap' }}>
        <Rating value={app.rating} />
        {app.candidate?.location && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <MapPin size={10} /> {app.candidate.location}
          </span>
        )}
        {app.source && <span>{app.source}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 10.5, color: '#94a3b8' }}>
        {app.candidate?.email && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
            <Mail size={10} /> {app.candidate.email}
          </span>
        )}
        {app.assigned_to && staffMap[app.assigned_to] && (
          <span>· {(staffMap[app.assigned_to] || '').split(' ')[0]}</span>
        )}
        {app.cover_note && <StickyNote size={10} />}
      </div>
    </div>
  );
}

function Column({ stage, apps, staffMap, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 240, flex: '1 1 0' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 11px', borderRadius: '10px 10px 0 0',
        background: stage.tone.bg, border: `1px solid ${stage.tone.border}`, borderBottom: 'none',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: stage.tone.fg, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {stage.label}
        </span>
        <span style={{ fontSize: 11, color: stage.tone.fg, opacity: 0.7 }}>{apps.length}</span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          flex: 1, minHeight: 120, padding: 8, display: 'flex', flexDirection: 'column', gap: 8,
          background: isOver ? stage.tone.bg : '#fafafa',
          border: `1px solid ${stage.tone.border}`, borderTop: 'none', borderRadius: '0 0 10px 10px',
          transition: 'background 0.12s',
        }}
      >
        {apps.length === 0 && (
          <div style={{ fontSize: 11.5, color: '#cbd5e1', textAlign: 'center', padding: '14px 0' }}>—</div>
        )}
        {apps.map((app) => (
          <Card key={app.id} app={app} staffMap={staffMap} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export default function PipelineBoard({ applications, staffMap, onOpen, onMove }) {
  const [activeId, setActiveId] = React.useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byStage = React.useMemo(() => {
    const buckets = Object.fromEntries(STAGES.map((s) => [s.key, []]));
    for (const a of applications) if (buckets[a.stage]) buckets[a.stage].push(a);
    return buckets;
  }, [applications]);

  const activeApp = activeId ? applications.find((a) => a.id === activeId) : null;

  function handleDragEnd(evt) {
    setActiveId(null);
    const { active, over } = evt;
    if (!over) return;
    const app = applications.find((a) => a.id === active.id);
    if (app && app.stage !== over.id) onMove(app, over.id);
  }

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setActiveId(e.active.id)} onDragEnd={handleDragEnd} onDragCancel={() => setActiveId(null)}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 8, fontFamily: font }}>
        {STAGES.map((stage) => (
          <Column key={stage.key} stage={stage} apps={byStage[stage.key] || []} staffMap={staffMap} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeApp ? (
          <div style={{ opacity: 0.95 }}>
            <Card app={activeApp} staffMap={staffMap} onOpen={() => {}} dragging />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
