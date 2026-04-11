import React, { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import { INITIAL_DEFAULTS } from './lib/defaults';
import NavShell from './components/NavShell';
import LoginPage from './pages/LoginPage';
import BootstrapPage from './pages/BootstrapPage';
import DashboardPage from './pages/DashboardPage';
import EntitiesPage from './pages/EntitiesPage';
import QuotesPage from './pages/QuotesPage';
import QuoteFormPage from './pages/QuoteFormPage';

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileChecked, setProfileChecked] = useState(false);
  const [defaults, setDefaults] = useState(INITIAL_DEFAULTS);
  const [view, setView] = useState('dashboard');
  const [selectedEntity, setSelectedEntity] = useState(null);

  // ── Listen for auth state changes ──
  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setSessionLoading(false);
    });

    // Subscribe to changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) {
        setProfile(null);
        setProfileChecked(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Check staff profile after auth ──
  useEffect(() => {
    if (!session) {
      setProfile(null);
      setProfileChecked(false);
      return;
    }

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
      setProfileChecked(true);
    })();
  }, [session]);

  // ── Load defaults after profile confirmed ──
  useEffect(() => {
    if (!profile) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from('quote_defaults')
          .select('*')
          .eq('is_current', true)
          .single();

        if (!error && data?.rates) {
          const dbRates = typeof data.rates === 'string' ? JSON.parse(data.rates) : data.rates;
          setDefaults({ ...INITIAL_DEFAULTS, ...dbRates, version: data.version || dbRates.version });
        }
      } catch {
        // Fall back to INITIAL_DEFAULTS silently
      }
    })();
  }, [profile]);

  // ── Handlers ──
  const handleLogout = async () => {
    await supabase.auth.signOut();
    setView('dashboard');
    setSelectedEntity(null);
  };

  const handleRetryProfile = () => {
    setProfileChecked(false);
    // Re-trigger the profile check effect
    setProfile(null);
    // Small delay then re-check
    setTimeout(() => {
      setProfileChecked(false);
      // Force re-run of the effect by toggling session reference
      setSession((s) => s ? { ...s } : s);
    }, 100);
  };

  const handleSelectEntity = (entity) => {
    setSelectedEntity(entity);
    setView('quote-new');
  };

  const handleQuoteSaved = () => {
    setView('quotes');
    setSelectedEntity(null);
  };

  const handleSetView = (v) => {
    setView(v);
    if (v !== 'quote-new') setSelectedEntity(null);
  };

  // ── Loading ──
  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  // ── Not logged in ──
  if (!session) return <LoginPage />;

  // ── Checking profile ──
  if (!profileChecked) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Checking access...</p>
      </div>
    );
  }

  // ── No staff profile ──
  if (!profile) {
    return <BootstrapPage user={session.user} onRetry={handleRetryProfile} onLogout={handleLogout} />;
  }

  // ── Authenticated with profile ──
  return (
    <NavShell view={view} setView={handleSetView} profile={profile} onLogout={handleLogout}>
      {view === 'dashboard' && <DashboardPage setView={setView} />}
      {view === 'entities' && <EntitiesPage onSelectEntity={handleSelectEntity} />}
      {view === 'quotes' && <QuotesPage onEdit={() => {}} />}
      {view === 'quote-new' && (
        <QuoteFormPage
          defaults={defaults}
          profile={profile}
          entity={selectedEntity}
          onSaved={handleQuoteSaved}
          onCancel={() => setView('dashboard')}
        />
      )}
    </NavShell>
  );
}
