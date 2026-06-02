import { supabase } from './supabase';

// "Remember this device for 90 days" support for MFA. The raw token lives
// in localStorage; only its sha-256 hash is stored in the database, so a
// dump of the table doesn't let anyone bypass MFA on other devices.

const STORAGE_KEY = 'mfaTrustedDeviceToken';
const TRUST_DAYS = 90;

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Returns true if this device has a valid (non-expired) trusted-device row
// for the given user. Bumps last_used_at on success.
export async function checkTrustedDevice(userId) {
  if (!userId) return false;
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) return false;
  try {
    const hash = await sha256Hex(token);
    const { data, error } = await supabase
      .from('mfa_trusted_devices')
      .select('id, expires_at')
      .eq('user_id', userId)
      .eq('token_hash', hash)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (error || !data) return false;
    // Best-effort touch; ignore failures.
    supabase.from('mfa_trusted_devices').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});
    return true;
  } catch {
    return false;
  }
}

// Issued after a successful MFA verify (challenge or enrolment). Writes
// the hash to mfa_trusted_devices with a 90-day expiry and stores the raw
// token in localStorage on this device.
export async function rememberThisDevice(userId) {
  if (!userId) return;
  try {
    const token = randomToken();
    const hash = await sha256Hex(token);
    const expires = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('mfa_trusted_devices').insert({
      user_id: userId,
      token_hash: hash,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 256) : null,
      device_label: 'Browser',
      expires_at: expires,
    });
    if (!error) localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* non-blocking */
  }
}

export function forgetThisDevice() {
  localStorage.removeItem(STORAGE_KEY);
}

export const TRUSTED_DEVICE_DAYS = TRUST_DAYS;
