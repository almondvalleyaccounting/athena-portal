// Shared signer/verifier for client-facing quote accept tokens.
// HS256 JWT, HMAC secret = SUPABASE_SERVICE_ROLE_KEY.
// Used by: send-quote-email (sign), verify-accept-token (verify), accept-quote (verify).

import {
  create as jwtCreate,
  verify as jwtVerify,
} from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const ACCEPT_TOKEN_TTL_DAYS = 14;
const PURPOSE = "quote_accept";

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
  quote_id: string;
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

/**
 * Returns claims on success; null on any failure (bad signature, expiry, wrong purpose).
 * Callers should treat null as "invalid or expired link".
 */
export async function verifyAcceptToken(
  token: string,
): Promise<AcceptTokenClaims | null> {
  if (!token || typeof token !== "string") return null;
  try {
    const key = await getKey();
    const payload = (await jwtVerify(token, key)) as Record<string, unknown>;
    if (payload.purpose !== PURPOSE) return null;
    if (typeof payload.quote_id !== "string") return null;
    if (typeof payload.recipient_email !== "string") return null;
    return payload as unknown as AcceptTokenClaims;
  } catch {
    return null;
  }
}
