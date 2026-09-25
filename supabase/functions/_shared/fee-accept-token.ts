// Signed links a client uses to accept a fee proposal (sql/300, sql/302).
//
// Same construction as the quote accept links (_shared/accept-token.ts) —
// HS256 over the service-role key — but its own purpose claim, so a quote
// link can't accept a fee proposal or the other way round: each verifier
// accepts only its own purpose.
//
// The token names the proposal and the address it was sent to. The real
// authority is the proposal row: a link works only while that proposal is
// still open (status "issued"), so withdrawing or superseding it kills the
// link, and accepting it makes the link show "already accepted".

import { create as jwtCreate, verify as jwtVerify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PURPOSE = "fee_proposal_accept";
// Outer bound only; the proposal's status is what's enforced.
const TTL_DAYS = 180;

export const PORTAL_PUBLIC_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!SECRET) throw new Error("Signing key not configured");
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
  }
  return keyPromise;
}

export interface FeeAcceptClaims {
  proposal_id: string;
  recipient_email: string;
  purpose: string;
  iat: number;
  exp: number;
}

export async function signFeeAcceptToken(proposalId: string, recipientEmail: string): Promise<string> {
  const key = await getKey();
  const now = Math.floor(Date.now() / 1000);
  return jwtCreate(
    { alg: "HS256", typ: "JWT" },
    { proposal_id: proposalId, recipient_email: recipientEmail, purpose: PURPOSE, iat: now, exp: now + TTL_DAYS * 86400 },
    key,
  );
}

export function feeAcceptUrl(token: string): string {
  return `${PORTAL_PUBLIC_URL}/accept-fee-change?token=${encodeURIComponent(token)}`;
}

/** Claims on success; null for a bad signature, expiry or another purpose. */
export async function verifyFeeAcceptToken(token: string): Promise<FeeAcceptClaims | null> {
  if (!token || typeof token !== "string") return null;
  try {
    const payload = await jwtVerify(token, await getKey()) as Record<string, unknown>;
    if (payload.purpose !== PURPOSE) return null;
    if (typeof payload.proposal_id !== "string" || typeof payload.recipient_email !== "string") return null;
    return payload as unknown as FeeAcceptClaims;
  } catch {
    return null;
  }
}
