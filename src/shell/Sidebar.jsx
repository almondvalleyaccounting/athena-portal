import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Receipt,
  BarChart2,
  Clock,
  GraduationCap,
  Lightbulb,
  Bug,
  Users,
  UserPlus,
  Table,
  FileText,
  AlertTriangle,
  TrendingUp,
  ClipboardCheck,
  Gauge,
  Briefcase,
  ChevronDown,
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
  bug: Bug,
  users: Users,
  'user-plus': UserPlus,
  table: Table,
  'file-text': FileText,
  'alert-triangle': AlertTriangle,
  'trending-up': TrendingUp,
  'clipboard-check': ClipboardCheck,
  gauge: Gauge,
  briefcase: Briefcase,
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
  const canImport = profile?.can_import_data === true || profile?.is_portal_admin === true;
  const canAdminTasks = profile?.can_view_onboarding === true || profile?.is_portal_admin === true;
  const adminChildren = [
    isOwner && { id: 'admin-staff', label: 'Staff & Permissions', route: '/admin/staff' },
    canImport && { id: 'admin-import', label: 'Data Import', route: '/admin/import' },
    // Workflow consolidated into the Work Planner module's Setup area
    // (/planner/setup). Admins reach it from inside Work Planner now.
    // Admin Task List moved into the Work module below — it's practice
    // admin (BM task keying), not system admin.
  ].filter(Boolean);
  const showAdminGroup = adminChildren.length > 0;
  const [adminExpanded, setAdminExpanded] = useState(false);
  useEffect(() => {
    if (location.pathname.startsWith('/admin')) setAdminExpanded(true);
  }, [location.pathname]);
  const initials = profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.email
    ? profile.email.charAt(0).toUpperCase()
    : '?';

  const [expandedModules, setExpandedModules] = useState({});

  const isActive = (route) => location.pathname.startsWith(route);

  // Route match as a whole path segment (exact, or a "/route/…" descendant).
  const routeMatches = (route) => {
    if (!route) return false;
    return location.pathname === route || location.pathname.startsWith(route + '/');
  };
  // A parent is "active" if its own route OR any child route matches — children
  // here don't necessarily share the parent's route prefix (e.g. Client Work).
  const moduleMatches = (mod) =>
    routeMatches(mod.route) || (mod.children || []).some((c) => routeMatches(c.route));

  // Auto-expand modules whose route (or a child's) matches the current path
  useEffect(() => {
    mainModules.forEach((mod) => {
      if (mod.children && moduleMatches(mod)) {
        setExpandedModules((prev) => ({ ...prev, [mod.id]: true }));
      }
    });
  }, [location.pathname]);

  const toggleExpand = (modId) => {
    setExpandedModules((prev) => ({ ...prev, [modId]: !prev[modId] }));
  };

  // Check if a child is the BEST match for the current path.
  // A more specific child route wins over a shorter prefix match.
  const isChildActive = (child, siblings) => {
    const p = location.pathname;
    if (child.route === '/manage') return p === '/manage';
    // Explicit matchPaths win — child is active iff current path is one of these
    if (Array.isArray(child.matchPaths) && child.matchPaths.length > 0) {
      return child.matchPaths.includes(p);
    }
    if (!p.startsWith(child.route)) return false;
    // Check no sibling has a longer, more specific match
    const dominated = (siblings || []).some(
      (s) => s.id !== child.id && s.route.length > child.route.length && p.startsWith(s.route)
    );
    return !dominated;
  };

  // Filter children by permissions
  const visibleChildren = (children) => {
    if (!children) return [];
    return children.filter((child) => {
      if (!child.permissions || child.permissions.length === 0) return true;
      return child.permissions.every((p) => profile?.[p] === true);
    });
  };

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
      {/* ── Company logo + branding ── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: collapsed ? '16px 0 8px' : '20px 16px 12px',
          borderBottom: '1px solid #f1f5f9',
          cursor: 'pointer',
        }}
        onClick={() => navigate('/home')}
      >
        <img
          src="/ava-logo.jpg"
          alt="AVA"
          style={{
            width: collapsed ? '32px' : '80px',
            height: 'auto',
            borderRadius: collapsed ? '6px' : '8px',
            imageRendering: 'auto',
            transition: 'width 0.2s ease',
            marginBottom: collapsed ? '0' : '8px',
          }}
        />
        {!collapsed && (
          <>
            <h1
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '16px',
                fontWeight: 700,
                color: '#0f172a',
                letterSpacing: '0.08em',
                textAlign: 'center',
                marginBottom: '2px',
              }}
            >
              ATHENA
            </h1>
            <p
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '11px',
                color: '#94a3b8',
                textAlign: 'center',
              }}
            >
              Almond Valley Accounting
            </p>
          </>
        )}
      </div>

      {/* ── Home link ── */}
      <div style={{ padding: collapsed ? '0 0 16px' : '0 16px 16px' }}>
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
          const active = moduleMatches(mod);
          const clickable = isModuleClickable(mod);
          const hasChildren = mod.children && mod.children.length > 0;
          const isExpanded = expandedModules[mod.id] && !collapsed;
          let kids = visibleChildren(mod.children);
          // Admin Task List lives under Work now — it's practice admin (BM
          // task keying, escalations), not system admin. Its OR-based
          // permission (can_view_onboarding OR is_portal_admin) doesn't fit
          // the AND-only modules.config model, so it's injected here rather
          // than declared as a static child.
          if (mod.id === 'work-planner' && canAdminTasks) {
            kids = [...kids, { id: 'wp-tasks', label: 'Admin Task List', route: '/planner/tasks' }];
          }
          // Hide a parent group that has children defined but none visible to
          // this user (e.g. Client Work when they lack every child's permission).
          if (hasChildren && kids.length === 0) return null;

          return (
            <React.Fragment key={mod.id}>
              <NavItem
                icon={IconComp}
                label={mod.label}
                active={active}
                collapsed={collapsed}
                clickable={clickable}
                planned={mod.status === 'planned'}
                beta={mod.status === 'beta'}
                hasChevron={hasChildren && !collapsed}
                chevronOpen={isExpanded}
                onClick={() => {
                  if (!clickable) return;
                  if (hasChildren) {
                    if (isExpanded) {
                      // Already expanded — just collapse, don't navigate
                      toggleExpand(mod.id);
                    } else {
                      // Collapsed — expand and navigate to module root
                      toggleExpand(mod.id);
                      navigate(mod.route);
                    }
                  } else {
                    navigate(mod.route);
                  }
                }}
              />
              {/* Sub-items */}
              {isExpanded && kids.length > 0 && (
                <div style={{ overflow: 'hidden', transition: 'max-height 0.2s ease' }}>
                  {kids.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => navigate(child.route)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        padding: '6px 12px 6px 44px',
                        borderRadius: 6,
                        border: 'none',
                        background: isChildActive(child, kids) ? 'rgba(56, 189, 248, 0.08)' : 'transparent',
                        cursor: 'pointer',
                        marginBottom: 1,
                        transition: 'background 0.15s',
                        position: 'relative',
                      }}
                      onMouseEnter={(e) => { if (!isChildActive(child, kids)) e.currentTarget.style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { if (!isChildActive(child, kids)) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {isChildActive(child, kids) && (
                        <div style={{
                          position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                          width: 2, height: 14, backgroundColor: '#38bdf8', borderRadius: '0 2px 2px 0',
                        }} />
                      )}
                      <span style={{
                        fontFamily: "'Outfit', sans-serif",
                        fontSize: 13,
                        fontWeight: isChildActive(child, kids) ? 600 : 400,
                        color: isChildActive(child, kids) ? '#0f172a' : '#64748b',
                      }}>
                        {child.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </React.Fragment>
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

        {/* Admin group — children depend on user permissions */}
        {showAdminGroup && (
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
              hasChevron={!collapsed && adminChildren.length > 0}
              chevronOpen={adminExpanded}
              onClick={() => {
                if (collapsed) {
                  // Collapsed sidebar: clicking Admin navigates to first available child
                  navigate(adminChildren[0].route);
                } else {
                  setAdminExpanded((v) => !v);
                }
              }}
            />
            {adminExpanded && !collapsed && adminChildren.map((child) => {
              const active = location.pathname.startsWith(child.route);
              return (
                <button
                  key={child.id}
                  onClick={() => navigate(child.route)}
                  style={{
                    display: 'flex', alignItems: 'center', width: '100%',
                    padding: '6px 12px 6px 44px', borderRadius: 6, border: 'none',
                    background: active ? 'rgba(56,189,248,0.08)' : 'transparent',
                    cursor: 'pointer', marginBottom: 1, position: 'relative',
                  }}
                >
                  {active && (
                    <div style={{
                      position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                      width: 2, height: 14, backgroundColor: '#38bdf8', borderRadius: '0 2px 2px 0',
                    }} />
                  )}
                  <span style={{
                    fontFamily: "'Outfit', sans-serif", fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: active ? '#0f172a' : '#64748b',
                  }}>{child.label}</span>
                </button>
              );
            })}
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
function NavItem({ icon: Icon, label, active, collapsed, clickable, planned, beta, hasChevron, chevronOpen, onClick }) {
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
          {hasChevron && (
            <ChevronDown
              size={14}
              style={{
                color: '#94a3b8',
                marginLeft: 'auto',
                transform: chevronOpen ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s ease',
                flexShrink: 0,
              }}
            />
          )}
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
