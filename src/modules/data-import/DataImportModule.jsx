import React from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import StatusView from './views/StatusView';
import ImportView from './views/ImportView';
import HistoryView from './views/HistoryView';
import { useAuth } from '../../shell/AppShell';

const font = "'Outfit', sans-serif";

const TABS = [
  { id: 'status', label: 'Status', path: '/admin/import' },
  { id: 'run', label: 'Import', path: '/admin/import/run' },
  { id: 'history', label: 'History', path: '/admin/import/history' },
];

export default function DataImportModule() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();

  const hasAccess = profile?.can_import_data === true || profile?.is_portal_admin === true;

  if (!hasAccess) {
    return (
      <div style={{ padding: 48, fontFamily: font, textAlign: 'center' }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', marginBottom: 10 }}>
          Access required
        </h2>
        <p style={{ fontSize: 14, color: '#64748b' }}>
          You need the <code>can_import_data</code> permission to use this module.
        </p>
      </div>
    );
  }

  const activeTab = (() => {
    if (location.pathname.startsWith('/admin/import/history')) return 'history';
    if (location.pathname.startsWith('/admin/import/run')) return 'run';
    return 'status';
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: font }}>
      {/* Page title + tabs */}
      <div style={{ padding: '20px 28px 0', background: '#fff', borderBottom: '1px solid #e5e7eb' }}>
        <h1 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 14,
        }}>
          Data Import
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

      {/* Routed view */}
      <div style={{ flex: 1, overflow: 'auto', background: '#fafafa' }}>
        <Routes>
          <Route index element={<StatusView />} />
          <Route path="run" element={<ImportView />} />
          <Route path="history" element={<HistoryView />} />
          <Route path="*" element={<Navigate to="/admin/import" replace />} />
        </Routes>
      </div>
    </div>
  );
}
