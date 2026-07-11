import React, { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../shell/AppShell';
import MyReviewView from './views/MyReviewView';
import ManagerView from './views/ManagerView';

const font = "'Outfit', sans-serif";

export default function JobReviewModule() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isManager = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const tabs = useMemo(() => {
    const t = [{ id: 'mine', label: 'My Review', path: '/planner/review' }];
    if (isManager) t.push({ id: 'team', label: 'Team', path: '/planner/review/team' });
    return t;
  }, [isManager]);

  const activeTab = location.pathname.startsWith('/planner/review/team') && isManager ? 'team' : 'mine';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: font }}>
      <div style={{ display: 'flex', background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 20px', alignItems: 'center' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => navigate(tab.path)}
            style={{
              padding: '10px 18px', fontSize: 14, fontWeight: 500,
              color: activeTab === tab.id ? '#0e7fe0' : '#64748b',
              cursor: 'pointer', border: 'none', background: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #0e7fe0' : '2px solid transparent',
              fontFamily: font,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minWidth: 0, minHeight: 0 }}>
        {activeTab === 'team' ? <ManagerView /> : <MyReviewView />}
      </div>
    </div>
  );
}
