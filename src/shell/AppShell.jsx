import React, { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ChangePasswordScreen from './ChangePasswordScreen';
import MFAChallenge from './MFAChallenge';
import SecurityPage from './SecurityPage';
import { CinematicPanel } from './LoginPage';
import { checkTrustedDevice } from '../lib/trustedDevice';
import useGlobalShortcuts from './useGlobalShortcuts';
import { ShortcutsModal } from './ShortcutsMap';

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

  // Global keyboard shortcuts ("g then x" chords, "?" shortcuts map,
  // "/" quick-search focus) — see src/shell/useGlobalShortcuts.js.
  const { shortcutsOpen, setShortcutsOpen } = useGlobalShortcuts();

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

  // ── MFA gate ──
  // Three states drive what we render:
  //   mustEnrol     — user has no verified TOTP factor; hard-block until they enrol.
  //   mustChallenge — user has a verified factor, session is aal1, and this
  //                   device is NOT remembered → show the 6-digit prompt.
  //   otherwise     — render the app normally.
  // 'Remember this device' (90 days) lets aal1 sessions skip the prompt
  // when a valid mfa_trusted_devices row matches the localStorage token.
  const [mfaState, setMfaState] = useState('checking'); // 'checking' | 'ok' | 'enrol' | 'challenge'
  const recheckMfa = React.useCallback(async () => {
    if (!session) { setMfaState('ok'); return; }
    const [{ data: aal }, { data: factors }] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);
    const verified = (factors?.totp || []).some((f) => f.status === 'verified');
    if (!verified) { setMfaState('enrol'); return; }
    if (aal?.currentLevel === 'aal2') { setMfaState('ok'); return; }
    // aal1 + has factor → maybe trusted device.
    const trusted = await checkTrustedDevice(session.user.id);
    setMfaState(trusted ? 'ok' : 'challenge');
  }, [session]);
  useEffect(() => { recheckMfa(); }, [recheckMfa]);

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

  // ── Wait until we know the MFA state before rendering anything that
  // might leak data behind the gate. ──
  if (mfaState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#fafafa' }}>
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 14, color: '#94a3b8' }}>Loading...</p>
      </div>
    );
  }

  // ── Hard block: no verified factor → must enrol before the app loads. ──
  // Mirror the login landing: message + enrol panel on the left, the
  // cinematic ATHENA panel on the right.
  if (mfaState === 'enrol') {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Outfit', sans-serif" }}>
        <div style={{ flex: 1, minWidth: 0, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 40px', overflow: 'auto' }}>
          <div style={{ width: '100%', maxWidth: 460 }}>
            <img src="/ava-logo.jpg" alt="AVA" style={{ width: 56, height: 56, borderRadius: 10, marginBottom: 20 }} />
            <h1 style={{ fontFamily: "'Major Mono Display', monospace", fontSize: 24, color: '#0f172a', marginBottom: 8 }}>ATHENA</h1>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: '8px 0 6px' }}>
              Set up two-factor authentication
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.5, marginBottom: 24 }}>
              Athena now holds live client data, so two-factor authentication is required before you can continue.
              Use Google Authenticator, Authy, 1Password, or any TOTP app on your phone — it takes about a minute.
            </p>
            <SecurityPage onEnrolled={recheckMfa} embedded />
            <button
              onClick={handleLogout}
              style={{ marginTop: 20, background: 'none', border: 'none', color: '#94a3b8', fontSize: 12, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
            >
              Sign out
            </button>
          </div>
        </div>
        <div style={{ width: 460, flexShrink: 0, display: 'flex' }}>
          <CinematicPanel />
        </div>
      </div>
    );
  }

  // ── Verified factor + aal1 + untrusted device → 6-digit challenge. ──
  if (mfaState === 'challenge') {
    return <MFAChallenge onPassed={recheckMfa} />;
  }

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
      {/* overflow-hidden: the shell owns exactly one viewport. Every scroll
          region lives inside <main> (or the sidebar nav), so the document
          itself must never scroll — if it does, full-height pages get pushed
          off the bottom of the window. */}
      <div
        className="h-screen flex overflow-hidden"
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

        {/* Keyboard shortcuts map — toggled by "?" anywhere */}
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      </div>
    </AuthContext.Provider>
  );
}
