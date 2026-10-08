import React, { useEffect } from 'react';
import { X } from 'lucide-react';

const font = "'Outfit', sans-serif";

/*
  The frame the onboarding modals share: dimmed backdrop, title row, a
  scrolling body and an optional footer. Escape and a backdrop click call
  onClose — the modal decides whether that needs a confirm.
*/
export default function ModalShell({ title, subtitle, width = 640, onClose, footer, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: font,
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-label={title}
        style={{
          background: '#fff', borderRadius: 12, width: `min(${width}px, 100%)`, maxHeight: 'calc(100vh - 32px)',
          display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)', cursor: 'default',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: '#64748b' }}>{subtitle}</div>}
          </div>
          <button
            onClick={onClose} title="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: '14px 18px', overflowY: 'auto', flex: 1, minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid #f1f5f9' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
