// fee-change-accept — Athena Portal (client-facing, public)
//
// Behind the "Review and accept" link in a fee proposal email
// (/accept-fee-change?token=…). The client isn't signed in: the signed
// token (_shared/fee-accept-token.ts) is the only credential, so deploy
// with verify_jwt = false, as for verify-accept-token / accept-quote.
//
// What a token can do, and nothing more:
//   { action: "view",   token }                 → the proposal it names, as issued
//   { action: "accept", token, name, agree: true } → accept it, once, while open
//
// It reads fee_proposals only by the id inside a valid token, returns only
// what that client was already sent (their own letter's figures), and
// writes only the acceptance fields of that one row. An expired token, a
// withdrawn or superseded proposal, or a notice (nothing to accept) all
// refuse. Acceptance records the recipient address the link was sent to,
// the name typed, IP and user agent (sql/302 requires the first two).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyFeeAcceptToken } from "../_shared/fee-accept-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

function clientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const claims = await verifyFeeAcceptToken(String(body.token || ""));
  if (!claims) return json({ ok: false, error: "invalid_or_expired" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: p } = await sb
    .from("fee_proposals")
    .select("id, entity_id, kind, status, effective_at, lines, summary, issued_at, accepted_at, accepted_via, entity:entities(name)")
    .eq("id", claims.proposal_id)
    .maybeSingle();
  if (!p || p.kind !== "proposal") return json({ ok: false, error: "not_found" }, 404);

  const view = {
    client_name: (p.entity as { name?: string } | null)?.name || "",
    effective_at: p.effective_at,
    issued_at: p.issued_at,
    summary: p.summary,
    lines: (Array.isArray(p.lines) ? p.lines : []).map((l: Record<string, unknown>) => ({
      service: l.service, current: l.current, next: l.next, reason: l.reason, build: l.build || null,
      needs_acceptance: l.needs_acceptance === true,
    })),
    recipient_email: claims.recipient_email,
  };

  if (body.action === "view") {
    if (p.status === "issued") {
      await sb.from("fee_proposals").update({ link_opened_at: new Date().toISOString() }).eq("id", p.id).is("link_opened_at", null);
    }
    return json({ ok: true, status: p.status, accepted_at: p.accepted_at, proposal: view });
  }

  if (body.action === "accept") {
    if (p.status === "accepted" || p.status === "pushed") {
      return json({ ok: true, already_accepted: true, accepted_at: p.accepted_at });
    }
    if (p.status !== "issued") return json({ ok: false, error: "no_longer_open" }, 410);
    const name = String(body.name || "").trim();
    if (body.agree !== true) return json({ ok: false, error: "agreement_required" }, 400);
    if (name.length < 2 || name.length > 120) return json({ ok: false, error: "name_required" }, 400);

    const now = new Date().toISOString();
    const { data: updated, error } = await sb.from("fee_proposals").update({
      status: "accepted",
      accepted_via: "client_link",
      accepted_at: now,
      accepted_client_email: claims.recipient_email || "unknown",
      accepted_name: name,
      accepted_ip: clientIp(req),
      accepted_user_agent: (req.headers.get("user-agent") || "").slice(0, 400),
      updated_at: now,
    }).eq("id", p.id).eq("status", "issued").select("id");
    if (error) return json({ ok: false, error: "could_not_record" }, 500);
    if (!updated || updated.length === 0) return json({ ok: false, error: "no_longer_open" }, 410);

    await sb.from("audit_log").insert({
      user_id: null, action: "fee_proposal_accepted", entity_type: "fee_proposal", entity_id: p.id,
      detail: { via: "client_link", name, recipient_email: claims.recipient_email, ip: clientIp(req) },
    });
    return json({ ok: true, accepted_at: now });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
