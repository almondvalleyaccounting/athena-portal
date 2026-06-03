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

    // ── Group token: return every member company for the accept page ────
    if (claims.is_group) {
      const groupId = claims.group_id as string;
      const quoteIds = (claims.quote_ids ?? []) as string[];
      const [{ data: groupRow }, { data: rows, error: gErr }] = await Promise.all([
        service.from("billing_groups").select("name").eq("id", groupId).maybeSingle(),
        service
          .from("quotes")
          .select("id, quote_ref, status, monthly_gross, annual_total, relationship_group, valid_until, accepted_at")
          .in("id", quoteIds),
      ]);
      if (gErr || !rows || rows.length === 0) {
        return jsonResponse({ ok: false, error: "quote_not_found" }, 404);
      }
      const companies = rows as Array<Record<string, unknown>>;
      const allAccepted = companies.every((q) => q.status === "accepted" || q.status === "committed");

      if (!allAccepted) {
        const today = new Date().toISOString().slice(0, 10);
        const earliest = companies
          .filter((q) => q.status === "sent" || q.status === "approved")
          .map((q) => q.valid_until as string | null)
          .filter(Boolean)
          .sort()[0] as string | undefined;
        if (earliest && earliest < today) {
          return jsonResponse({ ok: false, error: "expired", valid_until: earliest }, 410);
        }
      }

      try {
        await service.from("quote_events").insert(
          companies.map((q) => ({
            quote_id: q.id, event_type: "clicked_review",
            client_email: claims.recipient_email, client_ip: clientIp(req),
            user_agent: req.headers.get("user-agent"),
            metadata: { already_accepted: allAccepted, group_id: groupId },
          })),
        );
      } catch (logErr) {
        console.error("[verify-accept-token] group event log failed", logErr);
      }

      const monthlyGross = companies.reduce((s, q) => s + (Number(q.monthly_gross) || 0), 0);
      const annualTotal = companies.reduce((s, q) => s + (Number(q.annual_total) || 0), 0);
      const validUntil = companies.map((q) => q.valid_until as string | null).filter(Boolean).sort()[0] || null;

      return jsonResponse({
        ok: true,
        is_group: true,
        recipient_email: claims.recipient_email,
        already_accepted: allAccepted,
        group: {
          group_id: groupId,
          name: (groupRow?.name as string) || "Group quote",
          company_count: companies.length,
          monthly_gross: monthlyGross,
          annual_total: annualTotal,
          valid_until: validUntil,
          accepted_at: (companies.find((q) => q.accepted_at)?.accepted_at as string) || null,
          companies: companies.map((q) => ({
            quote_ref: q.quote_ref,
            relationship_group: q.relationship_group,
            monthly_gross: q.monthly_gross,
            annual_total: q.annual_total,
            status: q.status,
          })),
        },
      });
    }

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
