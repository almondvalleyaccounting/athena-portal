import React from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '../../../shell/AppShell';

import RulesView from './RulesView';
import AliasesView from './AliasesView';
import SettingsView from './SettingsView';

const font = "'Outfit', sans-serif";

// Preview moved to Work Planner > Waiting (it's an operational area
// used daily, not admin config). Setup is now config-only.
const TABS = [
  { id: 'rules',    label: 'Rules',         path: '/planner/setup/rules' },
  { id: 'aliases',  label: 'Staff aliases', path: '/planner/setup/aliases' },
  { id: 'settings', label: 'Settings',      path: '/planner/setup/settings' },
];

export default function SetupModule() {
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
          Setup is admin-only. You need <code>is_portal_admin</code> or <code>can_import_data</code>.
        </p>
      </div>
    );
  }

  const activeTab = (() => {
    const p = location.pathname;
    if (p.startsWith('/planner/setup/aliases')) return 'aliases';
    if (p.startsWith('/planner/setup/settings')) return 'settings';
    return 'rules';
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font, background: '#fafafa' }}>
      <div style={{
        padding: '18px 28px 0', background: '#fff', borderBottom: '1px solid #e5e7eb',
      }}>
        <button onClick={() => navigate('/planner')} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: 0, marginBottom: 10,
          fontSize: 12, color: '#64748b', background: 'none', border: 'none',
          cursor: 'pointer', fontFamily: font,
        }}>
          ← Back to work planner
        </button>
        <h1 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 24, fontWeight: 500, color: '#0f172a', marginBottom: 14,
        }}>
          Work planner setup
        </h1>
        <div style={{ display: 'flex', gap: 0 }}>
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => navigate(tab.path)}
                style={{
                  padding: '10px 18px',
                  fontSize: 13, fontWeight: active ? 600 : 500,
                  color: active ? '#0e7fe0' : '#64748b',
                  background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: active ? '2px solid #0e7fe0' : '2px solid transparent',
                  fontFamily: font, transition: 'all 0.15s', marginBottom: -1,
                }}>
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          <Route index element={<Navigate to="/planner/setup/rules" replace />} />
          {/* Legacy Preview URL redirects to the new Waiting tab. */}
          <Route path="preview" element={<Navigate to="/planner/waiting" replace />} />
          <Route path="rules" element={<RulesView />} />
          <Route path="aliases" element={<AliasesView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/planner/setup/rules" replace />} />
        </Routes>
      </div>
    </div>
  );
}
