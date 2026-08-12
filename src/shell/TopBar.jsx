import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { MODULES } from '../modules.config';
import { useAuth } from './AppShell';
import QuickSearch from './QuickSearch';
import ActivityBell from './ActivityBell';
import HelpButton from './HelpButton';

/* ─── Known sub-page labels keyed by pathname prefix ──────────
 * These are detail/feature routes accessed via in-page buttons rather
 * than the sidebar, so they don't live in modules.config. Mapping
 * them here gives the breadcrumb a trailing label like "QBO mapping"
 * and — via useBreadcrumb below — keeps the parent segment clickable.
 */
const SUBPAGES = [
  { prefix: '/clients/qbo-mapping', label: 'QBO mapping' },
  { prefix: '/manage/billing/qbo-mapping', label: 'QBO mapping' },
  { prefix: '/admin/import/run', label: 'Import' },
  { prefix: '/admin/import/history', label: 'History' },
  { prefix: '/admin/import', label: 'Data Import' },
  { prefix: '/planner/setup', label: 'Setup' },
  { prefix: '/planner/tasks', label: 'Admin Task List' },
  { prefix: '/admin/staff', label: 'Staff & Permissions' },
  { prefix: '/admin/portal-clients', label: 'Portal Clients' },
  { prefix: '/admin/connections', label: 'Connections' },
  { prefix: '/admin/schedules', label: 'Scheduled Jobs' },
  { prefix: '/settings/me', label: 'My Settings' },
  { prefix: '/settings/shortcuts', label: 'Keyboard shortcuts' },
];

/* ─── Enhanced breadcrumb: returns array of segments ─────────── */
function useBreadcrumb() {
  const { pathname } = useLocation();

  if (pathname === '/home') return [{ label: 'Home' }];

  // Settings routes (the group formerly labelled "Admin") — covers both
  // the admin-only /admin/* screens and the all-staff /settings/* pages.
  if (pathname.startsWith('/admin') || pathname.startsWith('/settings')) {
    const segments = [{ label: 'Settings' }];
    const sub = SUBPAGES.find((s) => pathname.startsWith(s.prefix));
    if (sub && sub.prefix !== pathname) segments.push({ label: sub.label });
    else if (sub) segments.push({ label: sub.label });
    return segments;
  }

  // Find matching module
  const mod = MODULES.find((m) => pathname.startsWith(m.route));
  if (!mod) return [];

  const segments = [{ label: mod.label, path: mod.route }];

  // For modules with children, find the active child
  if (mod.children) {
    const sorted = [...mod.children].sort((a, b) => b.route.length - a.route.length);
    const child = sorted.find((c) => {
      if (c.route === mod.route) return pathname === mod.route;
      return pathname.startsWith(c.route);
    });
    if (child && child.route !== mod.route) {
      segments.push({ label: child.label, path: child.route });
    }
  }

  // Tail segment for known sub-pages (e.g. /manage/billing/qbo-mapping)
  const sub = SUBPAGES.find((s) => pathname.startsWith(s.prefix));
  if (sub) {
    const lastSeg = segments[segments.length - 1];
    if (!lastSeg || lastSeg.label !== sub.label) {
      segments.push({ label: sub.label, path: sub.prefix });
    }
  }

  return segments;
}

/* ─── TopBar ──────────────────────────────────────────────────── */
export default function TopBar() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const breadcrumbs = useBreadcrumb();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const initials = profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.email
    ? profile.email.charAt(0).toUpperCase()
    : '?';

  const handleLogout = async () => {
    setMenuOpen(false);
    await supabase.auth.signOut();
    navigate('/login');
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  return (
    <header
      style={{
        height: 56, backgroundColor: '#ffffff',
        borderBottom: '1px solid #e5e7eb', padding: '0 16px',
        display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0,
      }}
    >
      {/* ── Left: Breadcrumb ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {breadcrumbs.map((seg, i) => {
          // A segment is clickable iff it has a path AND that path is
          // not the current pathname. This keeps "you are here"
          // non-clickable while letting parent segments route back,
          // even when they're the only segment in the list.
          const isCurrent = !seg.path || seg.path === location.pathname;
          return (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: '#cbd5e1', fontSize: 13, userSelect: 'none' }}>/</span>}
              {!isCurrent ? (
                <button
                  onClick={() => navigate(seg.path)}
                  style={{
                    fontFamily: "'Outfit', sans-serif", fontSize: 13,
                    fontWeight: 500, color: '#64748b', background: 'none',
                    border: 'none', cursor: 'pointer', padding: 0,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#0e7fe0'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; }}
                >
                  {seg.label}
                </button>
              ) : (
                <span style={{
                  fontFamily: "'Outfit', sans-serif", fontSize: 13,
                  fontWeight: 600, color: '#0f172a',
                }}>
                  {seg.label}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Center: Quick Search ── */}
      <QuickSearch />

      {/* ── Right: Bell + Avatar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, marginLeft: 'auto' }}>
        <HelpButton />
        <ActivityBell />

        {/* User avatar with dropdown */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              backgroundColor: profile?.colour || '#38bdf8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', cursor: 'pointer', transition: 'box-shadow 0.2s ease',
              boxShadow: menuOpen ? '0 0 0 2px #ffffff, 0 0 0 4px #38bdf8' : 'none',
            }}
            title={profile?.name || 'User'}
          >
            <span style={{
              fontFamily: "'Outfit', sans-serif", fontSize: 12,
              fontWeight: 600, color: '#ffffff',
            }}>
              {initials}
            </span>
          </button>

          {menuOpen && (
            <div style={{
              position: 'absolute', top: 40, right: 0,
              backgroundColor: '#ffffff', border: '1px solid #e5e7eb',
              borderRadius: 10, padding: 6, minWidth: 160,
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)', zIndex: 100,
            }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', marginBottom: 4 }}>
                <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 500, color: '#0f172a' }}>
                  {profile?.name || 'User'}
                </p>
                <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, color: '#94a3b8' }}>
                  {profile?.email || ''}
                </p>
              </div>
              <button
                onClick={() => { setMenuOpen(false); navigate('/settings/me'); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '8px 10px', background: 'none',
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                  fontFamily: "'Outfit', sans-serif", fontSize: 13,
                  fontWeight: 500, color: '#64748b', transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; e.currentTarget.style.color = '#0f172a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
              >
                My Settings
              </button>
              <button
                onClick={() => { setMenuOpen(false); navigate('/security'); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '8px 10px', background: 'none',
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                  fontFamily: "'Outfit', sans-serif", fontSize: 13,
                  fontWeight: 500, color: '#64748b', transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; e.currentTarget.style.color = '#0f172a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
              >
                Security & 2FA
              </button>
              <button
                onClick={handleLogout}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '8px 10px', background: 'none',
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                  fontFamily: "'Outfit', sans-serif", fontSize: 13,
                  fontWeight: 500, color: '#64748b', transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fef2f2'; e.currentTarget.style.color = '#ef4444'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#64748b'; }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>

      </div>
    </header>
  );
}
