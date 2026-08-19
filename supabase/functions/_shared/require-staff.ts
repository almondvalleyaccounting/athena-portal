// Authorisation for edge functions.
//
// THE POINT, because it is not obvious and getting it wrong is how this was open:
// `verify_jwt` at the gateway is NOT authentication. It only requires a JWT signed
// with the project secret — and the anon key is exactly that, and it ships in the
// frontend bundle. sql/125 even relies on this: the nightly cron called qbo-pull
// with the anon key as its bearer token. So for a function with no check of its own,
// verify_jwt=true and verify_jwt=false are the same thing: open to the internet.
//
// Every function therefore decides for itself who is calling. This mirrors the
// database predicate is_staff_or_service() (sql/230): an active staff member, or a
// service-role caller (pg_cron via pg_net, or another edge function). Anything else
// gets a 403 — including a caller holding nothing but the public anon key.
//
// Usage:
//   import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
//   ...
//   let caller;
//   try { caller = await requireStaffOrService(req); }
//   catch (e) { return authErrorResponse(e, corsHeaders); }
//
// Then use caller.userId for attribution rather than a caller-supplied initiated_by,
// which is forgeable by definition.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Caller =
  | { kind: "staff"; userId: string }
  | { kind: "service"; userId: null };

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/** Build the JSON 401/403/500 an AuthError describes. */
export function authErrorResponse(err: unknown, corsHeaders: Record<string, string> = {}) {
  const status = err instanceof AuthError ? err.status : 500;
  const error = err instanceof AuthError ? err.message : "Authorisation failed";
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * The `role` claim of a JWT, unverified.
 *
 * Safe for REJECTING only, never for granting: an attacker can put any claim in an
 * unsigned token. We use it to refuse anon by identity, because comparing against
 * SUPABASE_ANON_KEY does not work reliably — the platform may inject the newer
 * publishable key there while the frontend still ships the legacy anon JWT, so the
 * comparison silently misses. Granting still requires either the service-role key
 * (a shared secret, so unforgeable) or getUser(), which verifies the signature.
 */
function unverifiedRoleClaim(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const pad = "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + pad);
    const role = JSON.parse(json)?.role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/** Length-independent-leak-free compare, so a key check cannot be timed. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface RequireOptions {
  /** staff_profiles boolean column that must also be true (is_active always is). */
  flag?: string;
  /**
   * Accept service-role callers (pg_cron via pg_net, function-to-function).
   *
   * Defaults to true, and is SOUND ONLY WHEN THE FUNCTION IS DEPLOYED WITH
   * verify_jwt=true. The service branch trusts the token's `service_role` claim,
   * because comparing against SUPABASE_SERVICE_ROLE_KEY does not work: the platform
   * injects the newer sb_secret_… key there, while the crons authenticate with the
   * legacy service-role JWT held in Vault. Verified against prod — the Vault secret
   * decodes to {"role":"service_role"} and the gateway accepts it. Trusting that
   * claim is safe only because the gateway verified the signature first.
   *
   * Pass false for any function deployed with verify_jwt=false (an OAuth redirect, a
   * signed webhook). There the signature is unchecked, so the claim is forgeable.
   */
  allowService?: boolean;
}

/**
 * Resolve the caller, or throw AuthError.
 *
 * Second argument accepts a bare flag name as shorthand for { flag }.
 */
export async function requireStaffOrService(
  req: Request,
  opts?: string | RequireOptions,
): Promise<Caller> {
  const { flag: requiredFlag, allowService = true } =
    typeof opts === "string" ? { flag: opts, allowService: true } : (opts ?? {});
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // Fail closed. A misconfigured function must not degrade into an open one — that
  // is the mistake _shared/accept-token.ts makes with `?? ""` on its signing key.
  if (!url || !anonKey || !serviceKey) {
    throw new AuthError(500, "Auth not configured");
  }

  const token = bearerToken(req);
  if (!token) throw new AuthError(401, "Missing authorization");

  const role = unverifiedRoleClaim(token);

  // Order matters. The anon key is a syntactically valid JWT for this project, so it
  // is rejected by identity first — by its own role claim, and by key comparison as a
  // backstop — before any attempt to resolve it to a user.
  if (role === "anon") throw new AuthError(403, "Not authorised");
  if (secretsMatch(token, anonKey)) throw new AuthError(403, "Not authorised");

  // Machine callers: pg_cron via pg_net, and function-to-function calls. See
  // RequireOptions.allowService for why the claim is trusted here and when it is not.
  if (allowService && (secretsMatch(token, serviceKey) || role === "service_role")) {
    return { kind: "service", userId: null };
  }

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error } = await asCaller.auth.getUser();
  if (error || !user) throw new AuthError(401, "Invalid token");

  // staff_profiles is RLS-protected, so read it as the service role. A portal client
  // has no row here at all, which is what makes them fall through to the 403.
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const columns = requiredFlag ? `is_active, ${requiredFlag}` : "is_active";
  const { data: profile } = await service
    .from("staff_profiles")
    .select(columns)
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_active) throw new AuthError(403, "Not authorised");
  if (requiredFlag && !(profile as Record<string, unknown>)[requiredFlag]) {
    throw new AuthError(403, "Not authorised");
  }

  return { kind: "staff", userId: user.id };
}
