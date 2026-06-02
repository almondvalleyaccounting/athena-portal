// verify-accept-token — Athena Portal (client-facing, public)
// Verifies a signed accept-quote token and returns quote details so the
// /accept-quote page can render without the client needing to log in.
//
// This function is called anonymously (no user JWT). All auth is via the
// signed token. Deploy with --no-verify-jwt.
//
// Body: { token: string }
// Response (200):
//   { ok: true, recipient_email, already_accepted, quote: { ... summary ... } }
// Response (401): { ok: false, error: "invalid_or_expired" }
// Response (404): { ok: false, error: "quote_not_found" }
//
// Side effect (best-effort): inserts a `clicked_review` row into quote_events
// every time a valid token is verified. Failures are logged but do not
// affect the response — the accept page must still render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAcceptToken } from "../_shared/accept-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function clientIp(req: Request): string | null {
  // Supabase runs behind Cloudflare. cf-connecting-ip is the real client IP.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const token = (body as Record<string, unknown>).token as string | undefined;
    if (!token) {
      return jsonResponse({ ok: false, error: "token_required" }, 400);
    }

    const claims = await verifyAcceptToken(token);
    if (!claims) {
      return jsonResponse({ ok: false, error: "invalid_or_expired" }, 401);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: quote, error } = await service
      .from("quotes")
      .select(
        "id, quote_ref, status, monthly_gross, annual_total, relationship_group, valid_until, accepted_at",
      )
      .eq("id", claims.quote_id)
      .single();

    if (error || !quote) {
      return jsonResponse({ ok: false, error: "quote_not_found" }, 404);
    }

    // Source of truth for "already accepted" is status, not accepted_at.
    // A stale accepted_at can exist when staff have accepted then reverted
    // (status 'accepted' -> 'sent'). In that case the client can accept again.
    const alreadyAccepted =
      quote.status === "accepted" || quote.status === "committed";

    // Expiry is governed by the quote's valid_until (the figure shown to the
    // client), NOT the token's lifetime. Only blocks quotes still awaiting a
    // decision — already-accepted ones render their thank-you regardless.
    if (!alreadyAccepted && quote.valid_until) {
      const today = new Date().toISOString().slice(0, 10);
      if (quote.valid_until < today) {
        return jsonResponse({ ok: false, error: "expired", valid_until: quote.valid_until }, 410);
      }
    }

    // Log the review-click as a quote event. Best-effort: failure here must
    // never block the page from rendering.
    try {
      await service.from("quote_events").insert({
        quote_id: quote.id,
        event_type: "clicked_review",
        client_email: claims.recipient_email,
        client_ip: clientIp(req),
        user_agent: req.headers.get("user-agent"),
        metadata: { already_accepted: alreadyAccepted },
      });
    } catch (logErr) {
      console.error("[verify-accept-token] event log failed", logErr);
    }

    return jsonResponse({
      ok: true,
      recipient_email: claims.recipient_email,
      already_accepted: alreadyAccepted,
      quote: {
        id: quote.id,
        quote_ref: quote.quote_ref,
        status: quote.status,
        monthly_gross: quote.monthly_gross,
        annual_total: quote.annual_total,
        relationship_group: quote.relationship_group,
        valid_until: quote.valid_until,
        accepted_at: quote.accepted_at,
      },
    });
  } catch (err) {
    console.error("[verify-accept-token] error", err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
