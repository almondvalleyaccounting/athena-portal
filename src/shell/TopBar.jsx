import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, LogOut } from 'lucide-react';
import { supabase } from '../lib/supabase';
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
  const navigate = useNavigate();
  const breadcrumb = useBreadcrumb();
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

  // Close menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

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

      {/* ── Right: Bell + Avatar (with menu) + AVA logo ── */}
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

        {/* User avatar with dropdown */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: '#38bdf8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              cursor: 'pointer',
              transition: 'box-shadow 0.2s ease',
              boxShadow: menuOpen ? '0 0 0 2px #ffffff, 0 0 0 4px #38bdf8' : 'none',
            }}
            title={profile?.name || 'User'}
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
          </button>

          {/* Dropdown menu */}
          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: '40px',
                right: '0',
                backgroundColor: '#ffffff',
                border: '1px solid #e5e7eb',
                borderRadius: '10px',
                padding: '6px',
                minWidth: '160px',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
                zIndex: 100,
              }}
            >
              {/* User info */}
              <div
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid #f1f5f9',
                  marginBottom: '4px',
                }}
              >
                <p
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#0f172a',
                  }}
                >
                  {profile?.name || 'User'}
                </p>
                <p
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '11px',
                    color: '#94a3b8',
                  }}
                >
                  {profile?.email || ''}
                </p>
              </div>

              {/* Sign out */}
              <button
                onClick={handleLogout}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '8px 10px',
                  background: 'none',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#64748b',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#fef2f2';
                  e.currentTarget.style.color = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = '#64748b';
                }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
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
