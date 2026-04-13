import React, { useState, useRef, useEffect } from 'react';

export default function ActionPopover({ x, y, task, onClose, onOpen, onComplete, onNotReq, onDelete }) {
  const ref = useRef(null);
  const [mode, setMode] = useState('menu');
  const [mins, setMins] = useState('15');
  const [done, setDone] = useState(false);

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);

  // Clamp position to viewport
  const posX = Math.min(x, window.innerWidth - 200);
  const posY = Math.min(y, window.innerHeight - 60);

  const popStyle = {
    position: 'fixed',
    left: posX,
    top: posY,
    zIndex: 200,
    display: 'flex',
    gap: 1,
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    padding: 3,
    fontFamily: "'Outfit', sans-serif",
  };

  if (done) {
    return (
      <div ref={ref} style={popStyle}>
        <div
          style={{
            background: '#059669',
            color: '#fff',
            padding: '6px 14px',
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          &#10003; Done
        </div>
      </div>
    );
  }

  if (mode === 'complete') {
    return (
      <div ref={ref} style={popStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 5px' }}>
          <input
            type="number"
            min={1}
            max={999}
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setDone(true);
                setTimeout(() => onComplete(task, Number(mins) || 15), 400);
              }
            }}
            style={{
              width: 44,
              padding: '2px 4px',
              fontSize: 10,
              textAlign: 'center',
              fontFamily: "'Outfit', sans-serif",
              border: '1px solid #e5e7eb',
              borderRadius: 3,
              outline: 'none',
            }}
          />
          <span style={{ fontSize: 9, color: '#64748b' }}>min</span>
          <button
            onClick={() => {
              setDone(true);
              setTimeout(() => onComplete(task, Number(mins) || 15), 400);
            }}
            style={{
              padding: '2px 8px',
              fontSize: 9,
              fontWeight: 600,
              background: '#0e7fe0',
              color: '#fff',
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  const btnStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    padding: '4px 8px',
    borderRadius: 6,
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontFamily: "'Outfit', sans-serif",
    fontSize: 8,
    fontWeight: 500,
    color: '#1e293b',
    minWidth: 44,
  };

  return (
    <div ref={ref} style={popStyle}>
      <button
        style={btnStyle}
        onClick={() => onOpen(task)}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>&#9998;</span>
        Open
      </button>
      <button
        style={btnStyle}
        onClick={() => setMode('complete')}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>&#10003;</span>
        Done
      </button>
      <button
        style={btnStyle}
        onClick={() => onNotReq(task)}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>&#10005;</span>
        Not Req
      </button>
      {onDelete && (
        <button
          style={{ ...btnStyle, color: '#dc2626' }}
          onClick={() => onDelete(task)}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#fef2f2')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>&#128465;</span>
          Delete
        </button>
      )}
    </div>
  );
}
