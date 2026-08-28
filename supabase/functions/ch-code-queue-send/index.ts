// ch-code-queue-send — Athena Portal
// Sends manually-queued CH personal-code emails. Unlike ch-code-chase (the
// automated cron chaser), this is human-initiated: Sophie queues emails from
// the CH-code tiles, reviews the queue, then hits "Send All". Because a human
// deliberately reviews and triggers the batch, this path does NOT respect the
// ch_code_chase_config.sending_enabled gate — the review step is the safety.
//
// Each queue row already holds the fully-rendered subject/html/text (rendered
// from ch_code_email_templates at queue time), so this function just posts them
// to Resend, then:
//   * marks the queue row sent/failed (+ resend_id / error)
//   * logs an email_out activity on the request
//   * increments ch_code_requests.emails_sent (the current stage's comms ladder)
// The lifecycle stage itself is advanced manually by staff — never here.
//
// Auth: active-staff JWT (is_portal_admin / can_manage_portal / can_view_ch_codes).
// Body: { ids?: string[] }  — specific queued rows, or omit to send ALL queued.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";

// Resend delivers from its own infrastructure, so these never appear in
// info@'s Sent items — which is exactly why nobody could see them. A blind
// copy to info@ puts a visible record in the mailbox, and comms-ingest then
// files it against the client automatically. Blind, so the client never sees
// an internal address.
const CH_CODE_BCC_EMAIL =
  Deno.env.get("CH_CODE_BCC_EMAIL") ?? "info@almondvalleyaccounting.co.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: [opts.to],
      ...(CH_CODE_BCC_EMAIL ? { bcc: [CH_CODE_BCC_EMAIL] } : {}),
      subject: opts.subject, html: opts.html, text: opts.text,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || JSON.stringify(j)) };
}

type Row = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: active staff only ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal, can_view_ch_codes").eq("id", user.id).single();
  if (!prof || !(prof.is_portal_admin || prof.can_manage_portal || prof.can_view_ch_codes)) {
    return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body.ids) && body.ids.length ? body.ids : null;

  let q = service.from("ch_code_email_queue").select("*").eq("status", "queued");
  if (ids) q = q.in("id", ids);
  const { data: queued, error: qErr } = await q;
  if (qErr) return json({ success: false, error: qErr.message }, 500);
  if (!queued || queued.length === 0) return json({ success: true, sent: 0, results: [] });

  const today = new Date().toISOString().slice(0, 10);
  const results: Row[] = [];

  for (const item of queued as Row[]) {
    const to = String(item.to_email || "");
    const r = await sendEmail({ to, subject: String(item.subject), html: String(item.html), text: item.text ? String(item.text) : undefined });
    const nowIso = new Date().toISOString();

    if (r.ok) {
      await service.from("ch_code_email_queue").update({ status: "sent", resend_id: r.id, sent_at: nowIso, error: null }).eq("id", item.id as string);

      // Log + count + advance the request.
      const kind = String(item.kind);
      const label = kind === "offer" ? "Offer" : kind === "id_poa" ? "ID/POA reminder"
        : kind === "code" ? "Code reminder" : kind === "self_verify" ? "Self-verify reminder" : "Reminder";
      await service.from("ch_code_activity").insert({
        request_id: item.request_id as string, kind: "email_out",
        body: `${label} emailed to ${to} (from the queue)${CH_CODE_BCC_EMAIL ? `, blind copy to ${CH_CODE_BCC_EMAIL}` : ""}.`,
        created_by: user.id,
      });

      // Bump the current stage's comms ladder. The lifecycle stage is advanced
      // manually by staff (or, later, the automated chaser) — never here.
      const { data: reqRow } = await service.from("ch_code_requests").select("emails_sent").eq("id", item.request_id as string).maybeSingle();
      const prev = (reqRow?.emails_sent as number) || 0;
      const update: Row = { emails_sent: prev + 1, updated_at: nowIso };
      if (prev === 0) update.requested_at = today; // first email of this stage
      await service.from("ch_code_requests").update(update).eq("id", item.request_id as string);
    } else {
      await service.from("ch_code_email_queue").update({ status: "failed", error: String(r.error), sent_at: nowIso }).eq("id", item.id as string);
    }
    results.push({ id: item.id, to, kind: item.kind, ok: r.ok, resend_id: r.id, error: r.error });
  }

  await service.from("audit_log").insert({
    action: "ch_code_queue_sent", entity_type: "ch_code_email_queue", entity_id: null,
    detail: { by: user.id, count: results.length, sent: results.filter((x) => x.ok).length, results },
  });

  return json({ success: true, sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results });
});
