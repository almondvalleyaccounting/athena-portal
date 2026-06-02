import React, { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ChangePasswordScreen from './ChangePasswordScreen';

/* ─── Auth context ─────────────────────────────────────────────── */
const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

/* ─── App shell — layout route ─────────────────────────────────── */
export default function AppShell() {
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem('passwordRecovery') === '1'
  );

  // ── Listen for auth state ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (!s) {
        setLoading(false);
        navigate('/login', { replace: true });
      } else if (!localStorage.getItem('sessionStartedAt')) {
        // First load after a session was restored from storage — stamp it
        // so the daily logout check has something to compare against.
        localStorage.setItem('sessionStartedAt', String(Date.now()));
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_IN') {
        localStorage.setItem('sessionStartedAt', String(Date.now()));
      }
      if (!s) {
        setProfile(null);
        localStorage.removeItem('sessionStartedAt');
        setLoading(false);
        navigate('/login', { replace: true });
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  // ── Daily auto-logout at 00:01 GMT ──
  // Sessions issued before today's 00:01 GMT cutoff get signed out as soon
  // as the cutoff is reached (or on the next page focus / tick). Sessions
  // started after the cutoff survive until the next day's cutoff.
  useEffect(() => {
    if (!session) return;
    const todaysCutoff = () => {
      const now = new Date();
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 1, 0);
    };
    const check = async () => {
      const startedAt = Number(localStorage.getItem('sessionStartedAt') || 0);
      const cutoff = todaysCutoff();
      if (startedAt && startedAt < cutoff && Date.now() >= cutoff) {
        await supabase.auth.signOut();
      }
    };
    check();
    const id = setInterval(check, 60_000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [session]);

  // ── Load staff profile after auth ──
  useEffect(() => {
    if (!session) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from('staff_profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        if (error || !data) {
          setProfile(null);
        } else {
          setProfile(data);
        }
      } catch {
        setProfile(null);
      }
      setLoading(false);
    })();
  }, [session]);

  // ── Logout handler ──
  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: '#fafafa' }}
      >
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            color: '#94a3b8',
          }}
        >
          Loading...
        </p>
      </div>
    );
  }

  // ── Not authenticated ──
  if (!session) return null;

  // ── No profile — show access message ──
  if (!profile) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: '#fafafa' }}
      >
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            padding: '40px',
            maxWidth: '480px',
            width: '100%',
            border: '1px solid #e5e7eb',
            textAlign: 'center',
          }}
        >
          <h2
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '22px',
              fontWeight: 500,
              color: '#0f172a',
              marginBottom: '12px',
            }}
          >
            Access pending
          </h2>
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '14px',
              color: '#64748b',
              marginBottom: '24px',
              lineHeight: '1.6',
            }}
          >
            Your account exists but you don't have a staff profile yet. Ask your
            administrator to set up your profile.
          </p>
          <button
            onClick={handleLogout}
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              fontWeight: 600,
              color: '#64748b',
              background: 'none',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '10px 24px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // ── Must change password (first login OR password-reset recovery) ──
  if (profile.must_change_password || recovery) {
    return (
      <ChangePasswordScreen
        onComplete={async () => {
          if (profile.must_change_password) {
            await supabase.rpc('clear_my_must_change_password');
            setProfile((p) => ({ ...p, must_change_password: false }));
          }
          if (recovery) {
            sessionStorage.removeItem('passwordRecovery');
            setRecovery(false);
          }
        }}
        onLogout={handleLogout}
      />
    );
  }

  // ── Authenticated with profile — render shell ──
  return (
    <AuthContext.Provider value={{ session, profile, handleLogout }}>
      <div
        className="h-screen flex"
        style={{ backgroundColor: '#fafafa' }}
      >
        {/* Sidebar */}
        <Sidebar />

        {/* Main content area — bounded to viewport so pages with their
            own internal scroll regions (matrix views, table heatmaps)
            actually get a fixed-height parent. min-w-0 + min-h-0 stop
            the column from being pushed wider/taller by an oversized
            child; without those, a wide table would scroll the entire
            row flex and drag the sidebar offscreen. */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* TopBar */}
          <TopBar />

          {/* Page content */}
          <main className="flex-1 overflow-auto min-h-0 min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </AuthContext.Provider>
  );
}
