import React from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Network, Target, BookOpen, MessageSquare, Sparkles, ShieldCheck, UserCog } from 'lucide-react';
import { useAuth } from '../../shell/AppShell';
import DashboardView from './views/DashboardView';
import SkillsView from './views/SkillsView';
import ObjectivesView from './views/ObjectivesView';
import CPDView from './views/CPDView';
import OneToOnesView from './views/OneToOnesView';
import MandatoryView from './views/MandatoryView';
import RolesView from './views/RolesView';
import RecommendationsView from './views/RecommendationsView';

const TABS = [
  { id: 'dashboard',      label: 'Dashboard',       path: '/team/pd',                 icon: LayoutDashboard },
  { id: 'skills',         label: 'Skills',          path: '/team/pd/skills',          icon: Network },
  { id: 'objectives',     label: 'Objectives',      path: '/team/pd/objectives',      icon: Target },
  { id: 'cpd',            label: 'CPD log',         path: '/team/pd/cpd',             icon: BookOpen },
  { id: 'one-to-ones',    label: '1-2-1s',          path: '/team/pd/one-to-ones',     icon: MessageSquare },
  { id: 'mandatory',      label: 'Mandatory',       path: '/team/pd/mandatory',       icon: ShieldCheck },
  { id: 'roles',          label: 'Roles',           path: '/team/pd/roles',           icon: UserCog, adminOnly: true },
  { id: 'recommendations',label: 'Recommendations', path: '/team/pd/recommendations', icon: Sparkles },
];

export default function PDTrackerModule() {
  const location = useLocation();
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: '100%',
      fontFamily: "'Outfit', sans-serif", background: '#fafafa',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '0 28px', alignItems: 'center', overflowX: 'auto', flexShrink: 0,
      }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.id === 'dashboard'
            ? location.pathname === '/team/pd' || location.pathname === '/team/pd/'
            : location.pathname.startsWith(tab.path);
          return (
            <NavLink
              key={tab.id}
              to={tab.path}
              end={tab.id === 'dashboard'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '14px 16px', fontSize: 13, fontWeight: 500,
                color: active ? '#0e7fe0' : '#64748b',
                textDecoration: 'none',
                borderBottom: active ? '2px solid #0e7fe0' : '2px solid transparent',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon size={14} />
              {tab.label}
            </NavLink>
          );
        })}
      </div>

      <div style={{ flex: 1 }}>
        <Routes>
          <Route index element={<DashboardView />} />
          <Route path="skills" element={<SkillsView />} />
          <Route path="objectives" element={<ObjectivesView />} />
          <Route path="cpd" element={<CPDView />} />
          <Route path="one-to-ones" element={<OneToOnesView />} />
          <Route path="mandatory" element={<MandatoryView />} />
          {isAdmin && <Route path="roles" element={<RolesView />} />}
          <Route path="recommendations" element={<RecommendationsView />} />
          <Route path="*" element={<Navigate to="/team/pd" replace />} />
        </Routes>
      </div>
    </div>
  );
}
