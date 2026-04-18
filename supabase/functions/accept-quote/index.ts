// accept-quote — Athena Portal (client-facing, public)
// Records client acceptance of a quote. Verifies a signed accept token,
// marks the quote as accepted, records acceptance metadata for audit, logs
// an `accepted` row in quote_events, and sends two confirmation emails:
//   1. Client confirmation — reassures the client their acceptance landed.
//   2. Internal notification — tells AVA to review + push to QBO.
//
// Auth: anonymous (signed token only). Deploy with --no-verify-jwt.
//
// Body: { token: string }
// Response (200): { ok: true, quote_id, accepted_at, already_accepted }
// Response (401): { ok: false, error: "invalid_or_expired" }
// Response (404): { ok: false, error: "quote_not_found" }
// Response (400): { ok: false, error: "quote_not_sendable" }
//
// Email failures are best-effort: they are logged to the console but do NOT
// roll back the acceptance or fail the response. The client clicked accept
// and it was recorded — the UI confirmation must still render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAcceptToken } from "../_shared/accept-token.ts";
import {
  escapeHtml,
  formatDateGB,
  formatDateTimeGB,
  formatGBP,
  LineItem,
  renderBreakdownHtml,
} from "../_shared/email-format.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL =
  Deno.env.get("RESEND_FROM_EMAIL") || "accounts@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME =
  Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const PORTAL_PUBLIC_URL =
  Deno.env.get("PORTAL_PUBLIC_URL") ||
  "https://portal.almondvalleyaccounting.co.uk";

const INTERNAL_NOTIFICATION_RECIPIENTS = [
  "bobby@almondvalleyaccounting.co.uk",
  "info@almondvalleyaccounting.co.uk",
];
const CLIENT_REPLY_TO = "info@almondvalleyaccounting.co.uk";

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
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

// ---------- email templates ---------------------------------------------

type QuoteSummary = {
  id: string;
  quote_ref: string | null;
  relationship_group: string | null;
  monthly_gross: number | null;
  annual_total: number | null;
  valid_until: string | null;
};

function summaryTableHtml(quote: QuoteSummary): string {
  const ref = escapeHtml(String(quote.quote_ref ?? ""));
  const client = escapeHtml(String(quote.relationship_group ?? "Client"));
  const monthly = formatGBP(quote.monthly_gross);
  const annual = formatGBP(quote.annual_total);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;margin-top:16px;">
      <tr style="background:#f8fafc;">
        <td colspan="2" style="padding:10px 14px;font-weight:600;color:#0f172a;">Quote summary</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Reference</td>
        <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${ref}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Client</td>
        <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${client}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Monthly DD (inc VAT)</td>
        <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;font-weight:600;">${monthly}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Annual total (inc VAT)</td>
        <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${annual}</td>
      </tr>
    </table>`;
}

function emailShell(innerHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0"
                 style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
            ${innerHtml}
            <tr>
              <td style="padding-top:32px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">
                Almond Valley Accounting &middot; ${escapeHtml(PORTAL_PUBLIC_URL.replace(/^https?:\/\//, ""))}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderClientConfirmation(
  quote: QuoteSummary,
  acceptedAtIso: string,
): string {
  const inner = `
    <tr>
      <td>
        <h1 style="font-family:'Playfair Display',serif;font-size:24px;font-weight:500;color:#0f172a;margin:0 0 8px 0;">
          Thank you for accepting
        </h1>
        <p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0;">
          Your acceptance of quote ${escapeHtml(String(quote.quote_ref ?? ""))} was recorded on
          ${escapeHtml(formatDateGB(acceptedAtIso))}. We will be in touch shortly to finalise
          the engagement.
        </p>
        ${summaryTableHtml(quote)}
        <p style="font-size:12px;color:#64748b;margin-top:20px;line-height:1.6;">
          If you did not accept this quote, please reply to this email and let us know right away.
        </p>
      </td>
    </tr>`;
  return emailShell(inner);
}

function renderInternalNotification(
  quote: QuoteSummary,
  lineItems: LineItem[],
  ctx: {
    acceptedAtIso: string;
    clientEmail: string;
    clientIp: string | null;
    userAgent: string | null;
  },
): string {
  const portalLink = `${PORTAL_PUBLIC_URL}/manage/quotes/${quote.id}`;
  const metaRow = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 14px;color:#64748b;border-top:1px solid #f1f5f9;font-size:12px;">${escapeHtml(label)}</td>
      <td style="padding:8px 14px;color:#0f172a;border-top:1px solid #f1f5f9;font-size:12px;text-align:right;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`;

  const inner = `
    <tr>
      <td>
        <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;color:#38bdf8;text-transform:uppercase;">
          Quote accepted
        </div>
        <h1 style="font-family:'Playfair Display',serif;font-size:24px;font-weight:500;color:#0f172a;margin:6px 0 8px 0;">
          ${escapeHtml(String(quote.relationship_group ?? "A client"))} has accepted quote
          ${escapeHtml(String(quote.quote_ref ?? ""))}
        </h1>
        <p style="font-size:14px;line-height:1.6;color:#1e293b;margin:0;">
          Next step is to review the acceptance and push the quote to QBO.
        </p>
        ${summaryTableHtml(quote)}
        ${renderBreakdownHtml(lineItems)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-top:16px;">
          <tr style="background:#f8fafc;">
            <td colspan="2" style="padding:10px 14px;font-weight:600;color:#0f172a;font-size:13px;">
              Acceptance record
            </td>
          </tr>
          ${metaRow("Accepted at", formatDateTimeGB(ctx.acceptedAtIso))}
          ${metaRow("Client email", ctx.clientEmail)}
          ${metaRow("Client IP", ctx.clientIp ?? "—")}
          ${metaRow("User agent", ctx.userAgent ?? "—")}
        </table>
        <div style="margin-top:24px;">
          <a href="${escapeHtml(portalLink)}"
             style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                    padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;
                    font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
            Open quote in portal
          </a>
        </div>
      </td>
    </tr>`;
  return emailShell(inner);
}

// ---------- Resend send helper ------------------------------------------

async function sendResendEmail(params: {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const payload: Record<string, unknown> = {
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: Array.isArray(params.to) ? params.to : [params.to],
      subject: params.subject,
      html: params.html,
    };
    if (params.replyTo) payload.reply_to = params.replyTo;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        error:
          body?.message ||
          (typeof body === "object" ? JSON.stringify(body) : String(body)),
      };
    }
    return { ok: true, id: body?.id as string | undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- entry point -------------------------------------------------

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

    // Fetch quote + line items in parallel. Line items drive the breakdown
    // in the internal notification email (so Bobby can review the quote
    // contents at a glance without opening the portal).
    const [
      { data: quote, error: fetchErr },
      { data: lineItemsRaw, error: lineItemsErr },
    ] = await Promise.all([
      service
        .from("quotes")
        .select(
          "id, quote_ref, status, monthly_gross, annual_total, relationship_group, valid_until, accepted_at",
        )
        .eq("id", claims.quote_id)
        .single(),
      service
        .from("quote_line_items")
        .select("description, annual_amount, is_recurring, service_id, sort_order")
        .eq("quote_id", claims.quote_id)
        .order("sort_order"),
    ]);

    if (fetchErr || !quote) {
      return jsonResponse({ ok: false, error: "quote_not_found" }, 404);
    }
    if (lineItemsErr) {
      console.error("[accept-quote] line items fetch failed", lineItemsErr);
    }
    const lineItems = (lineItemsRaw ?? []) as unknown as LineItem[];

    // Idempotent — already accepted. Don't re-emit events or re-send emails.
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

    const { error: updateErr } = await service
      .from("quotes")
      .update({
        status: "accepted",
        accepted_at: acceptedAt,
        accepted_client_email: claims.recipient_email,
        accepted_ip: ip,
        accepted_user_agent: ua,
      })
      .eq("id", quote.id);

    if (updateErr) {
      console.error("[accept-quote] update error", updateErr);
      return jsonResponse(
        { ok: false, error: updateErr.message, hint: updateErr.hint ?? null },
        500,
      );
    }

    // Log the acceptance event. Best-effort — the acceptance itself is
    // already recorded on the quote row above.
    try {
      await service.from("quote_events").insert({
        quote_id: quote.id,
        event_type: "accepted",
        client_email: claims.recipient_email,
        client_ip: ip,
        user_agent: ua,
      });
    } catch (logErr) {
      console.error("[accept-quote] event log failed", logErr);
    }

    // Fire confirmation emails. Both are best-effort — failures are logged
    // but we still return success to the client.
    const summary: QuoteSummary = {
      id: quote.id,
      quote_ref: quote.quote_ref,
      relationship_group: quote.relationship_group,
      monthly_gross: quote.monthly_gross,
      annual_total: quote.annual_total,
      valid_until: quote.valid_until,
    };

    const clientEmailResult = await sendResendEmail({
      to: claims.recipient_email,
      subject: `Your quote has been accepted — ${quote.quote_ref ?? ""}`.trim(),
      html: renderClientConfirmation(summary, acceptedAt),
      replyTo: CLIENT_REPLY_TO,
    });
    if (!clientEmailResult.ok) {
      console.error(
        "[accept-quote] client confirmation email failed",
        clientEmailResult.error,
      );
    }

    const internalEmailResult = await sendResendEmail({
      to: INTERNAL_NOTIFICATION_RECIPIENTS,
      subject:
        `Quote ${quote.quote_ref ?? ""} accepted — ${quote.relationship_group ?? "client"}`.trim(),
      html: renderInternalNotification(summary, lineItems, {
        acceptedAtIso: acceptedAt,
        clientEmail: claims.recipient_email,
        clientIp: ip,
        userAgent: ua,
      }),
    });
    if (!internalEmailResult.ok) {
      console.error(
        "[accept-quote] internal notification email failed",
        internalEmailResult.error,
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
