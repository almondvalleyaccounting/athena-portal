// portal-notify — Athena Portal
// Emails staff when a client does something on the client portal. Called
// asynchronously from the portal RPCs via pg_net (portal_notify_async), the
// same pattern as doc-extract — so notifications go out however the action
// happened (reply, upload, done-claim, sent-another-way, service request).
//
// Recipients: the onboarding owner (staff_profiles email). 'sent_elsewhere'
// and 'service_request' additionally go to info@ (post/office handling).
//
// Auth: x-cron-secret matching PORTAL_NOTIFY_CRON_SECRET env /
// onboarding_chase_config.cron_secret. No user JWT — never invoked by browsers.
//
// Body: { kind: string, activity_id?: string, request_id?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("PORTAL_NOTIFY_CRON_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const INFO_EMAIL = Deno.env.get("AV_INFO_EMAIL") || "info@almondvalleyaccounting.co.uk";
const ATHENA_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).split(/[;,]/)[0].trim();
  return e.includes("@") ? e : null;
}

async function sendEmail(opts: { to: string[]; subject: string; html: string; text: string }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}

const KIND_META: Record<string, { headline: (entity: string) => string; extraInfo: boolean }> = {
  reply: { headline: (e) => `New message from ${e}`, extraInfo: false },
  upload: { headline: (e) => `Document uploaded by ${e}`, extraInfo: false },
  done_claim: { headline: (e) => `${e} marked a step as done`, extraInfo: false },
  sent_elsewhere: { headline: (e) => `${e} has sent something outside the portal`, extraInfo: true },
  not_received: { headline: (e) => `${e} says something hasn't arrived`, extraInfo: false },
  service_request: { headline: (e) => `Service request from ${e}`, extraInfo: true },
};

function buildEmail(opts: {
  headline: string; entityName: string; detail: string; note?: string | null;
  price?: string | null; onboardingId?: string | null;
}) {
  const link = opts.onboardingId ? `${ATHENA_URL}/onboarding/${opts.onboardingId}` : `${ATHENA_URL}/onboarding`;
  const subject = `Portal: ${opts.headline}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        <tr><td style="font-size:17px;font-weight:700;color:#1E4560;padding-bottom:10px;">${esc(opts.headline)}</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">${esc(opts.detail)}</td></tr>
        ${opts.note ? `<tr><td style="font-size:13.5px;line-height:1.6;color:#475569;padding-top:12px;"><strong>Client note:</strong> ${esc(opts.note)}</td></tr>` : ""}
        ${opts.price ? `<tr><td style="font-size:13.5px;line-height:1.6;color:#475569;padding-top:8px;"><strong>Indicative price shown:</strong> ${esc(opts.price)}</td></tr>` : ""}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(link)}" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · client portal notification</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `${opts.headline}\n\n${opts.detail}` +
    (opts.note ? `\n\nClient note: ${opts.note}` : "") +
    (opts.price ? `\nIndicative price shown: ${opts.price}` : "") +
    `\n\nOpen in Athena: ${link}`;
  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("onboarding_chase_config").select("cron_secret").eq("id", true).maybeSingle();
  const expected = CRON_SECRET || (cfg?.cron_secret as string) || "";
  const got = req.headers.get("x-cron-secret") || "";
  if (!expected || got !== expected) return json({ success: false, error: "Not authorised" }, 401);

  const body = await req.json().catch(() => ({}));
  const kind: string = body.kind || "";
  const activityId: string | null = body.activity_id || null;
  const requestId: string | null = body.request_id || null;
  const meta = KIND_META[kind];
  if (!meta) return json({ success: false, error: `unknown kind ${kind}` }, 400);

  let entityName = "Unknown client";
  let detail = "";
  let note: string | null = null;
  let price: string | null = null;
  let onboardingId: string | null = null;
  let ownerEmail: string | null = null;

  if (activityId) {
    const { data: act } = await service
      .from("onboarding_activity")
      .select("id, body, onboarding_id, onboarding:onboardings(id, entity_id, owner:staff_profiles!onboardings_owner_id_fkey(email, is_active), entity:entities!onboardings_entity_id_fkey(name))")
      .eq("id", activityId)
      .maybeSingle();
    if (!act) return json({ success: false, error: "activity not found" }, 404);
    const ob = act.onboarding as Record<string, unknown> | null;
    onboardingId = (ob?.id as string) || null;
    entityName = ((ob?.entity as Record<string, unknown>)?.name as string) || entityName;
    const owner = ob?.owner as Record<string, unknown> | null;
    if (owner?.email && owner.is_active !== false) ownerEmail = firstEmail(owner.email as string);
    detail = (act.body as string) || "";
  }

  if (kind === "service_request" && requestId) {
    const { data: reqRow } = await service
      .from("portal_service_requests")
      .select("service_title, service_id, note, indicative_monthly, indicative_annual, requested_email, entity:entities(name), onboarding_id")
      .eq("id", requestId)
      .maybeSingle();
    if (reqRow) {
      entityName = ((reqRow.entity as Record<string, unknown>)?.name as string) || entityName;
      onboardingId = onboardingId || (reqRow.onboarding_id as string) || null;
      detail = `Requested service: ${reqRow.service_title || reqRow.service_id} (by ${reqRow.requested_email || "portal user"})`;
      note = (reqRow.note as string) || null;
      if (reqRow.indicative_monthly != null) price = `from £${reqRow.indicative_monthly}/month`;
      else if (reqRow.indicative_annual != null) price = `from £${reqRow.indicative_annual}/year`;
      else price = "no indicative price shown — needs a quote";
      if (!ownerEmail && reqRow.onboarding_id) {
        const { data: ob2 } = await service
          .from("onboardings")
          .select("owner:staff_profiles!onboardings_owner_id_fkey(email, is_active)")
          .eq("id", reqRow.onboarding_id)
          .maybeSingle();
        const owner = ob2?.owner as Record<string, unknown> | null;
        if (owner?.email && owner.is_active !== false) ownerEmail = firstEmail(owner.email as string);
      }
    }
  }

  if (!detail) return json({ success: false, error: "nothing to notify" }, 400);

  const to = new Set<string>();
  if (ownerEmail) to.add(ownerEmail);
  if (meta.extraInfo || !ownerEmail) to.add(INFO_EMAIL);

  const email = buildEmail({ headline: meta.headline(entityName), entityName, detail, note, price, onboardingId });
  const r = await sendEmail({ to: [...to], ...email });

  await service.from("audit_log").insert({
    action: "portal_notify_sent", entity_type: "onboarding", entity_id: onboardingId,
    detail: { kind, to: [...to], resend_id: r.id, ok: r.ok, activity_id: activityId, request_id: requestId },
  });

  if (!r.ok) return json({ success: false, error: r.error }, 502);
  return json({ success: true, to: [...to] });
});
