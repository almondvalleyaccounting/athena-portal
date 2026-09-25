import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { INITIAL_DEFAULTS } from '../lib/defaults';
import { useAuth } from '../shell/AppShell';

/*
  FeeEngineContext — provides `defaults` (quote pricing defaults) and
  `reloadDefaults` to all Fee Engine pages. Replaces the state management
  that was previously in App.jsx.

  Wrap Fee Engine routes with <FeeEngineLayout /> which renders this
  provider around an <Outlet />.
*/

const FeeEngineContext = createContext(null);

// The current quote pricing defaults (quote_defaults.is_current), layered
// over INITIAL_DEFAULTS. Exported for pages outside the Fee Engine layout
// that still price at standard rates (the single-client fee review).
export async function fetchFeeDefaults() {
  try {
    const { data, error } = await supabase
      .from('quote_defaults')
      .select('*')
      .eq('is_current', true)
      .single();
    if (!error && data?.rates) {
      const dbRates = typeof data.rates === 'string' ? JSON.parse(data.rates) : data.rates;
      return { ...INITIAL_DEFAULTS, ...dbRates, version: data.version || dbRates.version };
    }
  } catch {
    // Fall back to INITIAL_DEFAULTS silently
  }
  return INITIAL_DEFAULTS;
}

export function useFeeEngine() {
  return useContext(FeeEngineContext);
}

function FeeEngineProvider({ children }) {
  const { profile } = useAuth();
  const [defaults, setDefaults] = useState(INITIAL_DEFAULTS);

  const loadDefaults = useCallback(async () => {
    setDefaults(await fetchFeeDefaults());
  }, []);

  useEffect(() => {
    if (profile) loadDefaults();
  }, [profile, loadDefaults]);

  return (
    <FeeEngineContext.Provider value={{ defaults, reloadDefaults: loadDefaults }}>
      {children}
    </FeeEngineContext.Provider>
  );
}

// Layout route wrapper — use as <Route element={<FeeEngineLayout />}>
export default function FeeEngineLayout() {
  return (
    <FeeEngineProvider>
      <Outlet />
    </FeeEngineProvider>
  );
}
