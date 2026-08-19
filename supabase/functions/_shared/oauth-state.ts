// Signed, single-use OAuth `state` for the QBO, Gmail and Drive flows.
//
// What state is for, and what it is not for. Historically these flows put a plain
// base64 blob in `state` and, coming back, decoded it "best-effort" and trusted the
// contents — including the staff id stamped onto the connection row. That let anyone
// mint a state for any user at the unauthenticated init endpoints, consent with their
// own Google or Intuit account, and have the callback install their tokens as the
// practice's. Signing alone does not close that: an attacker who can obtain a signed
// state for themselves is back where they started. So both halves are needed —
//
//   1. only an active staff member can obtain a state (the init endpoints require
//      staff and return a URL, rather than 302-ing anyone who asks), and
//   2. the state is HMAC-signed, time-limited, and single-use via a nonce row
//      (sql/236), so it cannot be forged, altered or replayed.
//
// The signing key is OAUTH_STATE_SECRET — deliberately its own secret. Reusing the
// service-role key to sign client-facing tokens (as _shared/accept-token.ts does)
// couples a low-value token's forgeability to the highest-value credential, and makes
// rotating that credential silently invalidate outstanding links.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // a consent round-trip is seconds; 10 min is generous
const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new StateError("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("OAUTH_STATE_SECRET");
  // Fail closed. An empty key would verify anything, which is how a signature check
  // becomes decoration.
  if (!secret || secret.length < 32) {
    throw new StateError("OAUTH_STATE_SECRET missing or too short");
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Constant-time compare of two byte arrays. */
function bytesMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface StatePayload {
  /** Flow this state belongs to, e.g. "qbo:billing", "gmail", "drive". */
  purpose: string;
  /** The active staff member who started the flow. Taken from their verified JWT. */
  userId: string;
  /** Relative in-app path to land on afterwards. */
  returnTo?: string;
  /** Flow-specific extras (mailbox kind, display name, set_default, …). */
  extra?: Record<string, unknown>;
}

/**
 * Record a nonce and return a signed state string.
 * Call from an init endpoint that has already established the caller is staff.
 */
export async function createSignedState(p: StatePayload, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const key = await hmacKey();
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));

  const sb = serviceClient();
  const { error } = await sb.from("oauth_state_nonces").insert({
    nonce,
    purpose: p.purpose,
    user_id: p.userId,
  });
  if (error) throw new StateError(`could not record state nonce: ${error.message}`);

  // Opportunistic cleanup; these rows are tiny and only useful for a few minutes.
  await sb
    .from("oauth_state_nonces")
    .delete()
    .lt("created_at", new Date(Date.now() - NONCE_RETENTION_MS).toISOString());

  const body = {
    p: p.purpose,
    u: p.userId,
    r: p.returnTo ?? "",
    n: nonce,
    e: Date.now() + ttlMs,
    ...(p.extra ?? {}),
  };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${b64urlEncode(sig)}`;
}

export interface VerifiedState {
  purpose: string;
  userId: string;
  returnTo: string;
  extra: Record<string, unknown>;
}

/**
 * Verify the signature, the expiry, the purpose, and consume the nonce.
 * Throws StateError on anything that does not add up — callers should treat that as
 * "refuse the callback", never as "carry on with defaults".
 */
export async function consumeSignedState(raw: string | null, expectedPurpose: string): Promise<VerifiedState> {
  if (!raw) throw new StateError("missing state");

  const parts = raw.split(".");
  if (parts.length !== 2) throw new StateError("malformed state");
  const [payload, sigPart] = parts;

  const key = await hmacKey();
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  let provided: Uint8Array;
  try {
    provided = b64urlDecode(sigPart);
  } catch {
    throw new StateError("malformed state signature");
  }
  if (!bytesMatch(expected, provided)) throw new StateError("bad state signature");

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    throw new StateError("unreadable state payload");
  }

  const { p: purpose, u: userId, r: returnTo, n: nonce, e: exp, ...extra } = body as {
    p?: string; u?: string; r?: string; n?: string; e?: number;
  } & Record<string, unknown>;

  if (purpose !== expectedPurpose) throw new StateError("state purpose mismatch");
  if (typeof exp !== "number" || Date.now() > exp) throw new StateError("state expired");
  if (!nonce || typeof userId !== "string" || !userId) throw new StateError("incomplete state");

  // Single-use. The conditional update is atomic, so a replayed callback matches zero
  // rows even if two arrive at once.
  const sb = serviceClient();
  const { data, error } = await sb
    .from("oauth_state_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .eq("purpose", expectedPurpose)
    .is("consumed_at", null)
    .select("user_id")
    .maybeSingle();

  if (error) throw new StateError(`could not consume state nonce: ${error.message}`);
  if (!data) throw new StateError("state already used or unknown");
  if (data.user_id !== userId) throw new StateError("state user mismatch");

  return { purpose, userId, returnTo: typeof returnTo === "string" ? returnTo : "", extra };
}

/** Only same-app relative paths, so `return_to` cannot become an open redirect. */
export function safeReturnTo(rt: unknown): string | null {
  return typeof rt === "string" && rt.startsWith("/") && !rt.startsWith("//") ? rt : null;
}
