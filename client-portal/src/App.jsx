import React, { useEffect, useState } from 'react';
import { supabase } from './supabase';
import LoginPage from './LoginPage';
import PortalHome from './PortalHome';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>Loading…</div>;
  }
  return session ? <PortalHome session={session} /> : <LoginPage />;
}
