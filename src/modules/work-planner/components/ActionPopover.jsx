import React, { useRef, useEffect } from 'react';
import { BTN } from '../../../lib/buttonStyles';

// The row-level action menu. Same three button kinds as everywhere else in
// Athena (buttonStyles.js): secondary for the choices, danger for Delete.
// It used to flash a green "Done" badge before the completion modal had
// even opened; nothing was done at that point, so the flash is gone.
export default function ActionPopover({ x, y, task, onClose, onOpen, onStartComplete, onStartNotReq, onDelete, onEmail }) {
  const ref = useRef(null);

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);

  // Clamp position to viewport
  const posX = Math.min(x, window.innerWidth - 340);
  const posY = Math.min(y, window.innerHeight - 60);

  const popStyle = {
    position: 'fixed',
    left: posX,
    top: posY,
    zIndex: 200,
    display: 'flex',
    gap: 6,
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    padding: 6,
    fontFamily: "'Outfit', sans-serif",
  };

  const btn = { ...BTN.secondary.sm, whiteSpace: 'nowrap' };

  // Deleting an occurrence of a recurring task deletes the whole series —
  // there is no per-occurrence delete — so say so before doing it.
  function handleDelete() {
    const series = task._instance || task.recurring;
    const msg = series
      ? `Delete "${task.title}" and every future occurrence of it? This removes the whole recurring task, not just this date.`
      : `Delete "${task.title}"?`;
    if (!window.confirm(msg)) return;
    onDelete(task);
  }

  return (
    <div ref={ref} style={popStyle}>
      <button style={btn} onClick={() => onOpen(task)}>Open</button>
      <button style={btn} onClick={() => onStartComplete(task)}>Done</button>
      <button style={btn} onClick={() => onStartNotReq(task)}>Not required</button>
      {onEmail && <button style={btn} onClick={() => onEmail(task)}>Email</button>}
      {onDelete && (
        <button style={{ ...BTN.danger.sm, whiteSpace: 'nowrap' }} onClick={handleDelete}>Delete</button>
      )}
    </div>
  );
}
