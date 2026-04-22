import React from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import CalendarView from './views/CalendarView';
import FlagsView from './views/FlagsView';
import { useAuth } from '../../shell/AppShell';

const font = "'Outfit', sans-serif";

const TABS = [
  { id: 'calendar', label: 'Workload', path: '/workflow/calendar' },
  { id: 'flags',    label: 'Reconciliation', path: '/workflow/flags' },
];

export default function StaffWorkflowModule() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();

  // Any active staffer can access (read-only on rules/aliases via admin)
  if (!profile || profile.is_active === false) {
    return (
      <div style={{ padding: 48, fontFamily: font, textAlign: 'center' }}>
        <p style={{ fontSize: 14, color: '#64748b' }}>Sign in required.</p>
      </div>
    );
  }

  const activeTab = (() => {
    if (location.pathname.startsWith('/workflow/flags')) return 'flags';
    return 'calendar';
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font }}>
      <div style={{ padding: '20px 28px 0', background: '#fff', borderBottom: '1px solid #e5e7eb' }}>
        <h1 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 14,
        }}>
          Workflow
        </h1>
        <div style={{ display: 'flex', gap: 0 }}>
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                style={{
                  padding: '10px 18px',
                  fontSize: 13, fontWeight: active ? 600 : 500,
                  color: active ? '#0e7fe0' : '#64748b',
                  background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: active ? '2px solid #0e7fe0' : '2px solid transparent',
                  fontFamily: font, transition: 'all 0.15s', marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', background: '#fafafa' }}>
        <Routes>
          <Route index element={<Navigate to="/workflow/calendar" replace />} />
          <Route path="calendar" element={<CalendarView />} />
          <Route path="flags" element={<FlagsView />} />
          <Route path="*" element={<Navigate to="/workflow/calendar" replace />} />
        </Routes>
      </div>
    </div>
  );
}
