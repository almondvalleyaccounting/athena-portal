import React, { useState } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core';
import CaseCard from './CaseCard';
import { STAGES, card } from './triageShared';

// Triage by stage. Drag a tile to another column to move it; dropping on
// Completed resolves the case (the database keeps status and stage in step).
// A small activation distance keeps a click (open the case) and a drag apart.

function DraggableCase(props) {
  // The DragOverlay draws the moving copy, so the original just dims in place.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: props.c.id });
  return (
    <CaseCard
      {...props}
      dragProps={{ setNodeRef, listeners, attributes, style: { opacity: isDragging ? 0.35 : undefined } }}
    />
  );
}

function Column({ stage, items, compact, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 230, flex: '1 1 0' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderRadius: '12px 12px 0 0',
        background: stage.tone.bg, border: `1px solid ${stage.tone.border}`, borderBottom: 'none',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: stage.tone.fg }}>
          {stage.label}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: stage.tone.fg }}>{items.length}</span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          ...card, borderRadius: '0 0 12px 12px', borderColor: isOver ? stage.tone.fg : stage.tone.border,
          background: isOver ? stage.tone.bg : '#fff', padding: 8, display: 'flex', flexDirection: 'column',
          gap: compact ? 5 : 8, minHeight: 120, flex: 1,
        }}
      >
        {items.length === 0 && (
          <div style={{ fontSize: 13, color: '#cbd5e1', textAlign: 'center', padding: '16px 0' }}>Nothing here</div>
        )}
        {children}
      </div>
    </div>
  );
}

export default function KanbanView({ cases, notesByCase, actionsByCase, staffMap, compact, onOpen, onMove }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [dragId, setDragId] = useState(null);
  const dragging = cases.find((c) => c.id === dragId) || null;

  const byStage = Object.fromEntries(STAGES.map((s) => [s.key, []]));
  for (const c of cases) (byStage[c.stage] || byStage.not_started).push(c);

  function handleDragEnd({ active, over }) {
    setDragId(null);
    if (!over) return;
    const c = cases.find((x) => x.id === active.id);
    if (c && c.stage !== over.id) onMove(c, over.id);
  }

  return (
    <DndContext sensors={sensors} onDragStart={({ active }) => setDragId(active.id)} onDragEnd={handleDragEnd} onDragCancel={() => setDragId(null)}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 4 }}>
        {STAGES.map((stage) => (
          <Column key={stage.key} stage={stage} items={byStage[stage.key]} compact={compact}>
            {byStage[stage.key].map((c) => (
              <DraggableCase
                key={c.id}
                c={c}
                notes={notesByCase[c.id] || []}
                actions={actionsByCase[c.id] || []}
                staffMap={staffMap}
                compact={compact}
                badge="category"
                onOpen={onOpen}
              />
            ))}
          </Column>
        ))}
      </div>
      <DragOverlay>
        {dragging && (
          <div style={{ boxShadow: '0 12px 32px rgba(15,23,42,0.22)', borderRadius: 10, width: 260 }}>
            <CaseCard c={dragging} staffMap={staffMap} compact badge="category" onOpen={() => {}} />
          </div>
        )}
      </DragOverlay>
      <p style={{ fontSize: 12.5, color: '#94a3b8', margin: '10px 2px 0' }}>
        Drag a case to another column to change its stage. Dropping it on Completed resolves it.
      </p>
    </DndContext>
  );
}
