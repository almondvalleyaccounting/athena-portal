// Shared signer/verifier for client-facing quote accept tokens.
// HS256 JWT, HMAC secret = SUPABASE_SERVICE_ROLE_KEY.
// Used by: send-quote-email (sign), verify-accept-token (verify), accept-quote (verify).

import {
  create as jwtCreate,
  verify as jwtVerify,
} from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Generous token lifetime. The REAL expiry rule is the quote's valid_until,
// enforced server-side by verify-accept-token / accept-quote. The token's
// own exp is just an outer bound, kept long so a link never dies before the
// quote it points at (previously a 14-day token expired well before a
// 30-day quote, locking clients out — Neon Fizz).
export const ACCEPT_TOKEN_TTL_DAYS = 120;
const PURPOSE = "quote_accept";
const PURPOSE_GROUP = "quote_accept_group";
// Effectively ignore the JWT's own exp when verifying — valid_until is the
// authority. Lets links already in clients' inboxes keep working.
const EXP_LEEWAY_SECONDS = 3650 * 24 * 60 * 60; // ~10 years

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return keyPromise;
}

export interface AcceptTokenClaims {
  // Single-quote tokens carry quote_id. Group tokens carry group_id +
  // quote_ids (every member quote the one link accepts). is_group tells
  // callers which shape they got.
  quote_id?: string;
  group_id?: string;
  quote_ids?: string[];
  is_group: boolean;
  recipient_email: string;
  purpose: string;
  iat: number;
  exp: number;
}

export async function signAcceptToken(input: {
  quoteId: string;
  recipientEmail: string;
}): Promise<string> {
  const key = await getKey();
  const now = Math.floor(Date.now() / 1000);
  return jwtCreate(
    { alg: "HS256", typ: "JWT" },
    {
      quote_id: input.quoteId,
      recipient_email: input.recipientEmail,
      purpose: PURPOSE,
      iat: now,
      exp: now + ACCEPT_TOKEN_TTL_DAYS * 24 * 60 * 60,
    },
    key,
  );
}

// Group accept token — one link that accepts every member quote of a group.
export async function signGroupAcceptToken(input: {
  groupId: string;
  quoteIds: string[];
  recipientEmail: string;
}): Promise<string> {
  const key = await getKey();
  const now = Math.floor(Date.now() / 1000);
  return jwtCreate(
    { alg: "HS256", typ: "JWT" },
    {
      group_id: input.groupId,
      quote_ids: input.quoteIds,
      recipient_email: input.recipientEmail,
      purpose: PURPOSE_GROUP,
      iat: now,
      exp: now + ACCEPT_TOKEN_TTL_DAYS * 24 * 60 * 60,
    },
    key,
  );
}

/**
 * Returns claims on success; null on any failure (bad signature, expiry, wrong purpose).
 * Handles both single-quote and group tokens — check `is_group` on the result.
 * Callers should treat null as "invalid or expired link".
 */
export async function verifyAcceptToken(
  token: string,
): Promise<AcceptTokenClaims | null> {
  if (!token || typeof token !== "string") return null;
  try {
    const key = await getKey();
    // Verify signature + claims, but don't let the token's own exp reject a
    // link whose quote is still valid — valid_until is enforced by callers.
    const payload = (await jwtVerify(token, key, { expLeeway: EXP_LEEWAY_SECONDS })) as Record<string, unknown>;
    if (typeof payload.recipient_email !== "string") return null;
    if (payload.purpose === PURPOSE_GROUP) {
      if (typeof payload.group_id !== "string") return null;
      if (!Array.isArray(payload.quote_ids) || payload.quote_ids.length === 0) return null;
      return { ...(payload as unknown as AcceptTokenClaims), is_group: true };
    }
    if (payload.purpose === PURPOSE) {
      if (typeof payload.quote_id !== "string") return null;
      return { ...(payload as unknown as AcceptTokenClaims), is_group: false };
    }
    return null;
  } catch {
    return null;
  }
}
