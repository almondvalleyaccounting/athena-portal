import React, { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';

/*
  Keyboard shortcuts map — shown two ways:
    • ShortcutsModal — overlay toggled by "?" anywhere (see
      useGlobalShortcuts.js, mounted in AppShell).
    • default ShortcutsPage — the same content at /settings/shortcuts,
      linked from the Settings sidebar group.
*/

const font = "'Outfit', sans-serif";
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

const SECTIONS = [
  {
    title: 'Go to',
    items: [
      { keys: ['g', 'h'], label: 'Home' },
      { keys: ['g', 'w'], label: 'Work Planner' },
      { keys: ['g', 't'], label: 'Admin Task List' },
      { keys: ['g', 'c'], label: 'Clients' },
      { keys: ['g', 'b'], label: 'Billing' },
      { keys: ['g', 's'], label: 'My Settings' },
    ],
    note: 'Press g, then the second key within 1.5 seconds.',
  },
  {
    title: 'Search',
    items: [
      { keys: [isMac ? '⌘' : 'Ctrl', 'K'], label: 'Focus quick search', combo: true },
      { keys: ['/'], label: 'Focus quick search' },
    ],
  },
  {
    title: 'Help',
    items: [
      { keys: ['?'], label: 'Show / hide this shortcuts map' },
      { keys: ['Esc'], label: 'Close the shortcuts map' },
    ],
  },
];

function Key({ children }) {
  return (
    <kbd
      style={{
        fontFamily: font,
        fontSize: 12,
        fontWeight: 600,
        color: '#0f172a',
        background: '#f8fafc',
        border: '1px solid #e5e7eb',
        borderBottom: '2px solid #cbd5e1',
        borderRadius: 6,
        padding: '2px 8px',
        minWidth: 14,
        display: 'inline-block',
        textAlign: 'center',
      }}
    >
      {children}
    </kbd>
  );
}

export function ShortcutsList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: font }}>
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: '#475569',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 8,
            }}
          >
            {section.title}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {section.items.map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 0',
                  borderBottom: '1px solid #f1f5f9',
                }}
              >
                <span style={{ fontSize: 13.5, color: '#334155' }}>{item.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {item.keys.map((k, j) => (
                    <React.Fragment key={j}>
                      {j > 0 && (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          {item.combo ? '+' : 'then'}
                        </span>
                      )}
                      <Key>{k}</Key>
                    </React.Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
          {section.note && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{section.note}</div>
          )}
        </div>
      ))}
      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Shortcuts are paused while you're typing in a text field.
      </div>
    </div>
  );
}

/* ─── Modal — toggled by "?" anywhere ─────────────────────────── */
export function ShortcutsModal({ onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          width: '100%',
          maxWidth: 480,
          maxHeight: '80vh',
          overflowY: 'auto',
          padding: '20px 24px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Keyboard size={16} color="#0e7fe0" />
          <span style={{ fontFamily: font, fontSize: 15, fontWeight: 600, color: '#0f172a', flex: 1 }}>
            Keyboard shortcuts
          </span>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#94a3b8',
              display: 'flex',
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>
        <ShortcutsList />
      </div>
    </div>
  );
}

/* ─── Page — /settings/shortcuts ──────────────────────────────── */
export default function ShortcutsPage() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <h1
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 28,
          fontWeight: 500,
          color: '#0f172a',
          marginBottom: 8,
        }}
      >
        Keyboard shortcuts
      </h1>
      <p style={{ fontFamily: font, fontSize: 14, color: '#64748b', marginBottom: 24 }}>
        Move around Athena without touching the mouse. Press <Key>?</Key> anywhere to bring
        this list up as a popup.
      </p>
      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '20px 24px',
        }}
      >
        <ShortcutsList />
      </div>
    </div>
  );
}
