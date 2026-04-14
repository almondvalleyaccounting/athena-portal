import React, { useState } from 'react';
import { X, Palette } from 'lucide-react';
import { STATUSES, TEAM_COLOURS } from '../lib/constants';
import { initials } from '../lib/helpers';

/*
  Colour settings panel for Work Planner calendar.
  Lets users assign colours to staff members and edit status colours.
  Persists to localStorage.
*/

const PALETTE = [
  // Blues
  '#1e3a5f', '#1e40af', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1',
  // Greens
  '#059669', '#10b981', '#34d399', '#15803d', '#65a30d', '#84cc16', '#0d9488', '#14b8a6',
  // Yellows & Ambers
  '#ca8a04', '#eab308', '#facc15', '#fde047', '#d97706', '#f59e0b', '#fbbf24',
  // Reds & Pinks
  '#dc2626', '#ef4444', '#f87171', '#db2777', '#ec4899', '#f472b6',
  // Purples
  '#7c3aed', '#8b5cf6', '#a78bfa', '#4f46e5', '#6366f1',
  // Teals & Cyans
  '#0891b2', '#06b6d4', '#22d3ee',
  // Neutrals
  '#0f172a', '#334155', '#475569', '#64748b', '#78716c', '#ea580c',
];

const LS_STAFF_KEY = 'athena_wp_staff_colours';
const LS_STATUS_KEY = 'athena_wp_status_colours';

// ── Read/write localStorage ──
export function loadStaffColours() {
  try {
    return JSON.parse(localStorage.getItem(LS_STAFF_KEY)) || {};
  } catch { return {}; }
}

export function loadStatusColours() {
  try {
    return JSON.parse(localStorage.getItem(LS_STATUS_KEY)) || {};
  } catch { return {}; }
}

function saveStaffColours(map) {
  localStorage.setItem(LS_STAFF_KEY, JSON.stringify(map));
}

function saveStatusColours(map) {
  localStorage.setItem(LS_STATUS_KEY, JSON.stringify(map));
}

export default function ColourSettings({ open, onClose, staffList, staffColours, setStaffColours, statusColours, setStatusColours }) {
  const [tab, setTab] = useState('staff');

  if (!open) return null;

  function handleStaffColour(staffId, colour) {
    const next = { ...staffColours, [staffId]: colour };
    setStaffColours(next);
    saveStaffColours(next);
  }

  function handleResetStaff(staffId) {
    const next = { ...staffColours };
    delete next[staffId];
    setStaffColours(next);
    saveStaffColours(next);
  }

  function handleStatusColour(statusId, colour) {
    const next = { ...statusColours, [statusId]: colour };
    setStatusColours(next);
    saveStatusColours(next);
  }

  function handleResetStatus(statusId) {
    const next = { ...statusColours };
    delete next[statusId];
    setStatusColours(next);
    saveStatusColours(next);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 480,
          padding: '28px 32px', boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
          position: 'relative', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 14, background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}
        >
          <X size={18} />
        </button>

        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
          Colour Settings
        </h2>
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, color: '#64748b', marginBottom: 20 }}>
          Customise tile colours on the calendar.
        </p>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
          {[{ id: 'staff', label: 'Staff Colours' }, { id: 'status', label: 'Status Colours' }].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                color: tab === t.id ? '#0f172a' : '#94a3b8',
                background: 'none', border: 'none',
                borderBottom: tab === t.id ? '2px solid #38bdf8' : '2px solid transparent',
                padding: '8px 16px', cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {tab === 'staff' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {staffList.map((s) => {
                const currentColour = staffColours[s.id] || null;
                const ini = initials(s.name);
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* Preview avatar */}
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: currentColour || TEAM_COLOURS[Math.abs(hashUUID(s.id)) % TEAM_COLOURS.length],
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 600, fontFamily: "'Outfit', sans-serif", flexShrink: 0,
                    }}>
                      {ini}
                    </div>
                    <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 500, color: '#0f172a', minWidth: 90 }}>
                      {s.name}
                    </span>
                    {/* Colour swatches */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                      {PALETTE.map((c) => (
                        <div
                          key={c}
                          onClick={() => handleStaffColour(s.id, c)}
                          style={{
                            width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer',
                            border: currentColour === c ? '2px solid #0f172a' : '2px solid transparent',
                            transition: 'border-color 0.1s',
                          }}
                        />
                      ))}
                    </div>
                    {currentColour && (
                      <button
                        onClick={() => handleResetStaff(s.id)}
                        style={{
                          fontFamily: "'Outfit', sans-serif", fontSize: 10, color: '#94a3b8',
                          background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'status' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {STATUSES.map((st) => {
                const currentColour = statusColours[st.id] || st.colour;
                return (
                  <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {/* Preview dot */}
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%', background: currentColour, flexShrink: 0,
                      marginLeft: 7,
                    }} />
                    <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 500, color: '#0f172a', minWidth: 120 }}>
                      {st.label}
                    </span>
                    {/* Colour swatches */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                      {PALETTE.map((c) => (
                        <div
                          key={c}
                          onClick={() => handleStatusColour(st.id, c)}
                          style={{
                            width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer',
                            border: currentColour === c ? '2px solid #0f172a' : '2px solid transparent',
                            transition: 'border-color 0.1s',
                          }}
                        />
                      ))}
                    </div>
                    {statusColours[st.id] && (
                      <button
                        onClick={() => handleResetStatus(st.id)}
                        style={{
                          fontFamily: "'Outfit', sans-serif", fontSize: 10, color: '#94a3b8',
                          background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function hashUUID(uuid) {
  if (!uuid) return 0;
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = ((hash << 5) - hash + uuid.charCodeAt(i)) | 0;
  }
  return hash;
}
