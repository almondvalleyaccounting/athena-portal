import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import TimesheetView from './views/TimesheetView';
import DashboardView from './views/DashboardView';

const TABS = [
  { id: 'timesheet', label: 'Timesheet', path: '/timesheets' },
  { id: 'dashboard', label: 'Dashboard', path: '/timesheets/dashboard' },
];

export default function TimesheetModule() {
  const navigate = useNavigate();
  const location = useLocation();

  const activeTab = location.pathname.includes('/dashboard') ? 'dashboard' : 'timesheet';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      fontFamily: "'Outfit', sans-serif",
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '0 20px', alignItems: 'center',
      }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => navigate(tab.path)}
            style={{
              padding: '10px 18px', fontSize: 14, fontWeight: 500,
              color: activeTab === tab.id ? '#0e7fe0' : '#64748b',
              cursor: 'pointer', border: 'none', background: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #0e7fe0' : '2px solid transparent',
              fontFamily: "'Outfit', sans-serif",
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active view */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activeTab === 'timesheet' && <TimesheetView />}
        {activeTab === 'dashboard' && <DashboardView />}
      </div>
    </div>
  );
}
