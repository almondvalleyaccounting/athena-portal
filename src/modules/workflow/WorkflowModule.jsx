import React from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import RulesView from './views/RulesView';
import AliasesView from './views/AliasesView';
import FlagsView from './views/FlagsView';
import CalendarView from './views/CalendarView';
import SettingsView from './views/SettingsView';
import { useAuth } from '../../shell/AppShell';

const font = "'Outfit', sans-serif";

const TABS = [
  { id: 'calendar', label: 'Workload preview', path: '/admin/workflow/calendar' },
  { id: 'flags',    label: 'Reconciliation',   path: '/admin/workflow/flags' },
  { id: 'rules',    label: 'Scheduling rules', path: '/admin/workflow/rules' },
  { id: 'aliases',  label: 'Staff aliases',    path: '/admin/workflow/aliases' },
  { id: 'settings', label: 'Feature flag',     path: '/admin/workflow/settings' },
];

export default function WorkflowModule() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();

  const hasAccess = profile?.is_portal_admin === true || profile?.can_import_data === true;

  if (!hasAccess) {
    return (
      <div style={{ padding: 48, fontFamily: font, textAlign: 'center' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', marginBottom: 10 }}>
          Access required
        </h2>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need <code>is_portal_admin</code> or <code>can_import_data</code> permission to edit workflow config.
        </p>
      </div>
    );
  }

  const activeTab = (() => {
    if (location.pathname.startsWith('/admin/workflow/aliases')) return 'aliases';
    if (location.pathname.startsWith('/admin/workflow/flags')) return 'flags';
    if (location.pathname.startsWith('/admin/workflow/rules')) return 'rules';
    if (location.pathname.startsWith('/admin/workflow/settings')) return 'settings';
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
          <Route index element={<Navigate to="/admin/workflow/calendar" replace />} />
          <Route path="calendar" element={<CalendarView />} />
          <Route path="rules" element={<RulesView />} />
          <Route path="aliases" element={<AliasesView />} />
          <Route path="flags" element={<FlagsView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/admin/workflow/calendar" replace />} />
        </Routes>
      </div>
    </div>
  );
}
