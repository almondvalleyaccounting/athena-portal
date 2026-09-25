import { createClient } from '@supabase/supabase-js';

// Trimmed: the Vercel value once carried a trailing newline. fetch() strips
// whitespace from header values so REST worked, but the realtime websocket
// puts the key in the query string untrimmed ("...%0A"), so every channel
// subscription in prod failed and nobody ever saw a colleague's change live.
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY env vars');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Flag recovery sessions so the shell can force a password-change screen
// regardless of must_change_password.
if (typeof window !== 'undefined') {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      sessionStorage.setItem('passwordRecovery', '1');
    }
  });
}
