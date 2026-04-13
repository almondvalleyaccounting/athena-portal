import React from 'react';
import { useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { MODULES } from '../modules.config';
import { useAuth } from './AppShell';

/* ─── Derive breadcrumb from current path ──────────────────────── */
function useBreadcrumb() {
  const { pathname } = useLocation();

  // Match current module from path
  const currentModule = MODULES.find((m) => pathname.startsWith(m.route));

  if (pathname === '/home') {
    return 'Home';
  }

  if (currentModule) {
    return currentModule.label;
  }

  if (pathname.startsWith('/admin')) {
    return 'Admin';
  }

  return '';
}

/* ─── TopBar component ─────────────────────────────────────────── */
export default function TopBar() {
  const { profile } = useAuth();
  const breadcrumb = useBreadcrumb();

  const initials = profile?.full_name
    ? profile.full_name.trim().charAt(0).toUpperCase()
    : profile?.name
    ? profile.name.trim().charAt(0).toUpperCase()
    : profile?.email
    ? profile.email.charAt(0).toUpperCase()
    : '?';

  return (
    <header
      style={{
        height: '56px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e5e7eb',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {/* ── Left: Badge + Wordmark + Breadcrumb ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Gradient badge */}
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, #0a0a0a, #1a1a2e)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '16px',
              fontWeight: 700,
              color: '#38bdf8',
            }}
          >
            A
          </span>
        </div>

        {/* ATHENA wordmark */}
        <span
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: '#1a1a2e',
          }}
        >
          ATHENA
        </span>

        {/* Breadcrumb separator + label */}
        {breadcrumb && (
          <>
            <span
              style={{
                color: '#cbd5e1',
                fontSize: '14px',
                userSelect: 'none',
              }}
            >
              /
            </span>
            <span
              style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: '11px',
                color: '#94a3b8',
                fontWeight: 400,
              }}
            >
              {breadcrumb}
            </span>
          </>
        )}
      </div>

      {/* ── Right: Bell + Avatar + AVA logo ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {/* Notifications bell — decorative */}
        <button
          style={{
            background: 'none',
            border: 'none',
            padding: '4px',
            cursor: 'default',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Notifications"
        >
          <Bell size={20} style={{ color: '#94a3b8' }} />
        </button>

        {/* User avatar */}
        <div
          title={profile?.full_name || 'User'}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: '#38bdf8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '12px',
              fontWeight: 600,
              color: '#ffffff',
            }}
          >
            {initials}
          </span>
        </div>

        {/* AVA logo */}
        <img
          src="/ava-logo.jpg"
          alt="AVA"
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            flexShrink: 0,
          }}
        />
      </div>
    </header>
  );
}
