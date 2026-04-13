import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Receipt,
  BarChart2,
  Clock,
  GraduationCap,
  Lightbulb,
  ChevronLeft,
  ChevronRight,
  Settings,
  Home,
} from 'lucide-react';
import { MODULES } from '../modules.config';
import { useAuth } from './AppShell';

/* ─── Icon map — Lucide icons keyed by modules.config icon string ── */
const ICON_MAP = {
  receipt: Receipt,
  'bar-chart-2': BarChart2,
  clock: Clock,
  'graduation-cap': GraduationCap,
  lightbulb: Lightbulb,
};

/* ─── Visibility rules ─────────────────────────────────────────── */
function isModuleVisible(mod, profile) {
  const isOwner = profile?.can_manage_portal === true;
  const isManager = false; // role column not yet in DB

  if (mod.status === 'live') {
    // No permissions required → visible to all
    if (!mod.permissions || mod.permissions.length === 0) return true;
    // Check each permission flag on profile
    return mod.permissions.every((perm) => profile?.[perm] === true);
  }

  if (mod.status === 'planned') {
    return isOwner || isManager;
  }

  return false;
}

function isModuleClickable(mod) {
  return mod.status === 'live';
}

/* ─── Sidebar component ───────────────────────────────────────── */
export default function Sidebar() {
  const { profile, handleLogout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Collapse state — persisted to localStorage, auto-collapse on narrow viewports
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('athena_sidebar_collapsed');
    if (stored !== null) return stored === 'true';
    return window.innerWidth < 1024;
  });

  // Auto-collapse on resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setCollapsed(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('athena_sidebar_collapsed', String(next));
      return next;
    });
  };

  // Filter modules by visibility
  const visibleModules = MODULES.filter((mod) => isModuleVisible(mod, profile));

  // Split: main modules vs Ideas (always last before admin)
  const mainModules = visibleModules.filter((m) => m.group !== 'meta');
  const metaModules = visibleModules.filter((m) => m.group === 'meta');

  const isOwner = profile?.can_manage_portal === true;
  const initials = profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.email
    ? profile.email.charAt(0).toUpperCase()
    : '?';

  const isActive = (route) => location.pathname.startsWith(route);

  return (
    <div
      className="flex flex-col shrink-0 border-r"
      style={{
        width: collapsed ? '56px' : '240px',
        backgroundColor: '#ffffff',
        borderColor: '#e5e7eb',
        transition: 'width 0.2s ease',
      }}
    >
      {/* ── Home link ── */}
      <div style={{ padding: collapsed ? '16px 0' : '16px' }}>
        <NavItem
          icon={Home}
          label="Home"
          active={location.pathname === '/home'}
          collapsed={collapsed}
          onClick={() => navigate('/home')}
          clickable
        />
      </div>

      {/* ── Module navigation ── */}
      <nav className="flex-1 px-0" style={{ padding: collapsed ? '0' : '0 8px' }}>
        {/* Main modules */}
        {mainModules.map((mod) => {
          const IconComp = ICON_MAP[mod.icon] || Receipt;
          const active = isActive(mod.route);
          const clickable = isModuleClickable(mod);

          return (
            <NavItem
              key={mod.id}
              icon={IconComp}
              label={mod.label}
              active={active}
              collapsed={collapsed}
              clickable={clickable}
              planned={mod.status === 'planned'}
              beta={mod.status === 'beta'}
              onClick={() => clickable && navigate(mod.route)}
            />
          );
        })}

        {/* Separator */}
        {metaModules.length > 0 && (
          <div
            style={{
              height: '1px',
              backgroundColor: '#f1f5f9',
              margin: collapsed ? '8px 12px' : '8px 8px',
            }}
          />
        )}

        {/* Meta modules (Ideas) */}
        {metaModules.map((mod) => {
          const IconComp = ICON_MAP[mod.icon] || Lightbulb;
          const active = isActive(mod.route);
          const clickable = isModuleClickable(mod);

          return (
            <NavItem
              key={mod.id}
              icon={IconComp}
              label={mod.label}
              active={active}
              collapsed={collapsed}
              clickable={clickable}
              planned={mod.status === 'planned'}
              onClick={() => clickable && navigate(mod.route)}
            />
          );
        })}

        {/* Admin link — Bobby only */}
        {isOwner && (
          <>
            <div
              style={{
                height: '1px',
                backgroundColor: '#f1f5f9',
                margin: collapsed ? '8px 12px' : '8px 8px',
              }}
            />
            <NavItem
              icon={Settings}
              label="Admin"
              active={isActive('/admin')}
              collapsed={collapsed}
              clickable
              onClick={() => navigate('/admin')}
            />
          </>
        )}
      </nav>

      {/* ── User profile row ── */}
      <div
        style={{
          padding: collapsed ? '12px 0' : '12px 16px',
          borderTop: '1px solid #f1f5f9',
        }}
      >
        {collapsed ? (
          <div className="flex justify-center">
            <div
              title={profile?.name || 'User'}
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                backgroundColor: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 600,
                color: '#ffffff',
                fontFamily: "'Outfit', sans-serif",
                cursor: 'pointer',
              }}
              onClick={handleLogout}
            >
              {initials}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                backgroundColor: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 600,
                color: '#ffffff',
                fontFamily: "'Outfit', sans-serif",
                flexShrink: 0,
              }}
            >
              {initials}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p
                style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#0f172a',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {profile?.name || 'User'}
              </p>
              <p
                style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: '11px',
                  color: '#94a3b8',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {profile?.email || ''}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Collapse toggle ── */}
      <button
        onClick={toggleCollapse}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '10px',
          background: 'none',
          border: 'none',
          borderTop: '1px solid #f1f5f9',
          cursor: 'pointer',
          color: '#94a3b8',
          transition: 'color 0.2s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#64748b')}
        onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </div>
  );
}

/* ─── Nav item sub-component ───────────────────────────────────── */
function NavItem({ icon: Icon, label, active, collapsed, clickable, planned, beta, onClick }) {
  const [hovered, setHovered] = useState(false);

  const baseStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: collapsed ? '0' : '10px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    width: '100%',
    padding: collapsed ? '10px 0' : '8px 12px',
    borderRadius: '8px',
    border: 'none',
    background: active ? 'rgba(56, 189, 248, 0.08)' : hovered && clickable ? '#f8fafc' : 'transparent',
    cursor: planned ? 'default' : clickable ? 'pointer' : 'default',
    position: 'relative',
    marginBottom: '2px',
    transition: 'all 0.2s ease',
  };

  // Active left accent
  const accentStyle = active
    ? {
        position: 'absolute',
        left: collapsed ? '0' : '-8px',
        top: '50%',
        transform: 'translateY(-50%)',
        width: '3px',
        height: '20px',
        backgroundColor: '#38bdf8',
        borderRadius: '0 3px 3px 0',
      }
    : {};

  const iconColor = active ? '#38bdf8' : planned ? '#94a3b8' : '#64748b';
  const labelColor = active ? '#0f172a' : planned ? '#94a3b8' : '#1e293b';

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={baseStyle}
      title={collapsed ? label : planned ? 'Coming soon' : undefined}
    >
      {active && <div style={accentStyle} />}
      <Icon
        size={collapsed ? 20 : 18}
        style={{ color: iconColor, flexShrink: 0 }}
      />
      {!collapsed && (
        <>
          <span
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '14px',
              fontWeight: active ? 600 : 500,
              color: labelColor,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          {beta && (
            <span
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '10px',
                fontWeight: 600,
                color: '#d97706',
                backgroundColor: '#fef3c7',
                padding: '1px 6px',
                borderRadius: '8px',
                marginLeft: 'auto',
              }}
            >
              Beta
            </span>
          )}
          {planned && (
            <span
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '10px',
                color: '#94a3b8',
                marginLeft: 'auto',
              }}
            >
              Soon
            </span>
          )}
        </>
      )}

      {/* Tooltip when collapsed and planned */}
      {collapsed && hovered && planned && (
        <div
          style={{
            position: 'absolute',
            left: '56px',
            top: '50%',
            transform: 'translateY(-50%)',
            backgroundColor: '#0f172a',
            color: '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontSize: '12px',
            padding: '4px 10px',
            borderRadius: '6px',
            whiteSpace: 'nowrap',
            zIndex: 50,
            pointerEvents: 'none',
          }}
        >
          Coming soon
        </div>
      )}

      {/* Tooltip when collapsed — show label */}
      {collapsed && hovered && !planned && (
        <div
          style={{
            position: 'absolute',
            left: '56px',
            top: '50%',
            transform: 'translateY(-50%)',
            backgroundColor: '#0f172a',
            color: '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontSize: '12px',
            padding: '4px 10px',
            borderRadius: '6px',
            whiteSpace: 'nowrap',
            zIndex: 50,
            pointerEvents: 'none',
          }}
        >
          {label}
        </div>
      )}
    </button>
  );
}
