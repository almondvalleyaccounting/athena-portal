import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { INITIAL_DEFAULTS } from './lib/defaults';
import NavShell from './components/NavShell';
import LoginPage from './pages/LoginPage';
import BootstrapPage from './pages/BootstrapPage';
import DashboardPage from './pages/DashboardPage';
import EntitiesPage from './pages/EntitiesPage';
import QuotesPage from './pages/QuotesPage';
import QuoteFormPage from './pages/QuoteFormPage';
import QuoteDetailPage from './pages/QuoteDetailPage';
import PricingDefaultsPage from './pages/PricingDefaultsPage';
import GroupQuoteFormPage from './pages/GroupQuoteFormPage';

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileChecked, setProfileChecked] = useState(false);
  const [defaults, setDefaults] = useState(INITIAL_DEFAULTS);

  const navigate = useNavigate();

  // -- Listen for auth state changes --
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setSessionLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) {
        setProfile(null);
        setProfileChecked(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // -- Check staff profile after auth --
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

  // -- Load defaults after profile confirmed --
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

  // -- Handlers --
  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  const handleRetryProfile = () => {
    setProfileChecked(false);
    setProfile(null);
    setTimeout(() => {
      setProfileChecked(false);
      setSession((s) => s ? { ...s } : s);
    }, 100);
  };

  const reloadDefaults = async () => {
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
    } catch { /* silent */ }
  };

  // -- Loading --
  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  // -- Not logged in --
  if (!session) return <LoginPage />;

  // -- Checking profile --
  if (!profileChecked) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Checking access...</p>
      </div>
    );
  }

  // -- No staff profile --
  if (!profile) {
    return <BootstrapPage user={session.user} onRetry={handleRetryProfile} onLogout={handleLogout} />;
  }

  // -- Authenticated with profile --
  return (
    <NavShell profile={profile} onLogout={handleLogout}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/manage/clients" element={<EntitiesPage />} />
        <Route path="/manage/quotes" element={<QuotesPage />} />
        <Route path="/manage/quotes/new" element={
          <QuoteFormPage defaults={defaults} profile={profile} mode="new" />
        } />
        <Route path="/manage/quotes/pricing" element={
          <PricingDefaultsPage defaults={defaults} profile={profile} onSaved={reloadDefaults} />
        } />
        <Route path="/manage/quotes/group/new" element={
          <GroupQuoteFormPage defaults={defaults} profile={profile} mode="new" />
        } />
        <Route path="/manage/quotes/group/:id/edit" element={
          <GroupQuoteFormPage defaults={defaults} profile={profile} mode="edit" />
        } />
        <Route path="/manage/quotes/:id" element={
          <QuoteDetailPage profile={profile} />
        } />
        <Route path="/manage/quotes/:id/edit" element={
          <QuoteFormPage defaults={defaults} profile={profile} mode="edit" />
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </NavShell>
  );
}
