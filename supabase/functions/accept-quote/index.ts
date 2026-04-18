// accept-quote — Athena Portal (client-facing, public)
// Records client acceptance of a quote. Verifies a signed accept token,
// marks the quote as accepted, and records acceptance metadata for audit.
//
// This function is called anonymously (no user JWT). All auth is via the
// signed token. Deploy with --no-verify-jwt.
//
// Body: { token: string }
// Response (200): { ok: true, quote_id, accepted_at, already_accepted }
// Response (401): { ok: false, error: "invalid_or_expired" }
// Response (404): { ok: false, error: "quote_not_found" }
// Response (400): { ok: false, error: "quote_not_sendable" }

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
  // Fallback to x-forwarded-for (first entry).
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

    // Fetch quote
    const { data: quote, error: fetchErr } = await service
      .from("quotes")
      .select("id, status, accepted_at")
      .eq("id", claims.quote_id)
      .single();

    if (fetchErr || !quote) {
      return jsonResponse({ ok: false, error: "quote_not_found" }, 404);
    }

    // Idempotent — already accepted
    if (quote.status === "accepted" || quote.status === "committed") {
      return jsonResponse({
        ok: true,
        quote_id: quote.id,
        accepted_at: quote.accepted_at,
        already_accepted: true,
      });
    }

    // Only quotes that were sent (or still approved — unusual but permissive)
    // can be accepted by the client.
    if (!["sent", "approved"].includes(quote.status)) {
      return jsonResponse(
        {
          ok: false,
          error: "quote_not_sendable",
          current_status: quote.status,
        },
        400,
      );
    }

    const acceptedAt = new Date().toISOString();
    const ip = clientIp(req);
    const ua = req.headers.get("user-agent");

    const update: Record<string, unknown> = {
      status: "accepted",
      accepted_at: acceptedAt,
      accepted_client_email: claims.recipient_email,
      accepted_ip: ip,
      accepted_user_agent: ua,
    };

    const { error: updateErr } = await service
      .from("quotes")
      .update(update)
      .eq("id", quote.id);

    if (updateErr) {
      console.error("[accept-quote] update error", updateErr);
      return jsonResponse(
        { ok: false, error: updateErr.message, hint: updateErr.hint ?? null },
        500,
      );
    }

    return jsonResponse({
      ok: true,
      quote_id: quote.id,
      accepted_at: acceptedAt,
      already_accepted: false,
    });
  } catch (err) {
    console.error("[accept-quote] error", err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
