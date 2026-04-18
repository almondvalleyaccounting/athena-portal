// send-quote-email — Athena Portal
// Sends an approved/sent quote to a client via Resend, with optional signed
// accept link. Moves status + audit-log updates server-side for atomicity.
//
// Caller requires staff_profiles.can_approve_quotes = true.
// Quote status must be 'approved' or 'sent' at call time.
//
// Body:
//   {
//     quote_id | quoteId       : string (uuid)      required
//     to                       : string (email)     required
//     cc                       : string[]           optional
//     subject                  : string             required
//     message                  : string             optional (plain text; \n -> <br>)
//     pdfBase64 | pdf_base64   : string (base64)    optional (attached if present)
//     filename                 : string             optional (defaults to quote_ref)
//     include_accept_link      : boolean            optional (default true)
//   }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  signAcceptToken,
  ACCEPT_TOKEN_TTL_DAYS,
} from "../_shared/accept-token.ts";
import {
  escapeHtml,
  formatDateGB,
  formatGBP,
} from "../_shared/email-format.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL =
  Deno.env.get("RESEND_FROM_EMAIL") || "accounts@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME =
  Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const PORTAL_PUBLIC_URL =
  Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

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

// Helpers (escapeHtml, formatGBP, formatDateGB) live in _shared/email-format.ts
// so send-quote-email and accept-quote share the same rendering primitives.
// Accept-token signing lives in _shared/accept-token.ts so verify-accept-token
// and accept-quote functions share the same HMAC key and payload schema.

type LineItem = {
  description: string | null;
  annual_amount: number | string | null;
  is_recurring: boolean | null;
  service_id: string | null;
  sort_order: number | null;
};

function renderBreakdownHtml(lineItems: LineItem[]): string {
  // Split the line items the same way the PDF does: recurring accountancy,
  // software (service_id starts with "software"), one-off setup fees.
  const recurring = lineItems.filter(
    (l) => l.is_recurring && !(l.service_id ?? "").startsWith("software"),
  );
  const software = lineItems.filter((l) =>
    (l.service_id ?? "").startsWith("software"),
  );
  const setup = lineItems.filter((l) => !l.is_recurring);

  if (!recurring.length && !software.length && !setup.length) return "";

  const row = (
    label: string,
    annual: number,
    opts: { bold?: boolean; muted?: boolean } = {},
  ) => {
    const monthly = annual / 12;
    const weight = opts.bold ? "600" : "400";
    const color = opts.muted ? "#64748b" : "#0f172a";
    const labelColor = opts.bold ? "#0f172a" : opts.muted ? "#64748b" : "#1e293b";
    return `
      <tr>
        <td style="padding:8px 14px;color:${labelColor};font-weight:${weight};border-top:1px solid #f1f5f9;">
          ${escapeHtml(label)}
        </td>
        <td style="padding:8px 14px;color:${color};text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">
          ${formatGBP(annual)}
        </td>
        <td style="padding:8px 14px;color:${color};text-align:right;border-top:1px solid #f1f5f9;font-weight:${weight};white-space:nowrap;">
          ${formatGBP(monthly)}
        </td>
      </tr>`;
  };

  const sectionHeader = (label: string) => `
    <tr style="background:#f8fafc;">
      <td colspan="3" style="padding:10px 14px;font-weight:600;color:#0f172a;border-top:1px solid #e5e7eb;">
        ${escapeHtml(label)}
      </td>
    </tr>
    <tr style="background:#f8fafc;">
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;">Service</td>
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Annual (net)</td>
      <td style="padding:6px 14px;font-size:11px;color:#94a3b8;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;text-align:right;">Monthly (net)</td>
    </tr>`;

  let rows = "";

  if (recurring.length) {
    rows += sectionHeader("Recurring services");
    for (const l of recurring) {
      const annual = Number(l.annual_amount) || 0;
      if (annual <= 0) continue;
      rows += row(l.description ?? "", annual);
    }
    const total = recurring.reduce(
      (s, l) => s + (Number(l.annual_amount) || 0),
      0,
    );
    rows += row("Total accountancy", total, { bold: true });
  }

  if (software.length) {
    rows += sectionHeader("Software");
    for (const l of software) {
      const annual = Number(l.annual_amount) || 0;
      if (annual <= 0) continue;
      rows += row(l.description ?? "", annual);
    }
  }

  if (setup.length) {
    // Setup fees are one-offs — annual_amount is the full fee, monthly is
    // meaningless. Show a single-column layout.
    const setupTotal = setup.reduce(
      (s, l) => s + (Number(l.annual_amount) || 0),
      0,
    );
    rows += `
      <tr style="background:#f8fafc;">
        <td colspan="3" style="padding:10px 14px;font-weight:600;color:#0f172a;border-top:1px solid #e5e7eb;">
          One-off setup fees
        </td>
      </tr>`;
    for (const l of setup) {
      const amt = Number(l.annual_amount) || 0;
      if (amt <= 0) continue;
      rows += `
        <tr>
          <td style="padding:8px 14px;color:#1e293b;border-top:1px solid #f1f5f9;">${escapeHtml(l.description ?? "")}</td>
          <td colspan="2" style="padding:8px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;white-space:nowrap;">${formatGBP(amt)}</td>
        </tr>`;
    }
    rows += `
      <tr>
        <td style="padding:8px 14px;color:#0f172a;font-weight:600;border-top:1px solid #f1f5f9;">Total setup fees</td>
        <td colspan="2" style="padding:8px 14px;color:#0f172a;font-weight:600;border-top:1px solid #f1f5f9;text-align:right;white-space:nowrap;">${formatGBP(setupTotal)}</td>
      </tr>`;
  }

  return `
    <tr>
      <td style="padding-top:16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
          ${rows}
        </table>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
          Figures shown net of VAT. Monthly Direct Debit in the summary above is inclusive of VAT.
        </div>
      </td>
    </tr>`;
}

function renderEmailHtml(opts: {
  messageHtml: string;
  quote: Record<string, unknown>;
  lineItems: LineItem[];
  acceptUrl: string | null;
}): string {
  const { messageHtml, quote, lineItems, acceptUrl } = opts;

  const ref = escapeHtml(String(quote.quote_ref ?? ""));
  const client = escapeHtml(String(quote.relationship_group ?? "Client"));
  const monthly = formatGBP(quote.monthly_gross as number);
  const annual = formatGBP(quote.annual_total as number);
  const validUntil = formatDateGB(quote.valid_until as string);
  const breakdownBlock = renderBreakdownHtml(lineItems);

  const acceptBlock = acceptUrl
    ? `
      <tr>
        <td style="padding:24px 0 0 0;">
          <a href="${escapeHtml(acceptUrl)}"
             style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                    padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;
                    font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
            Review &amp; accept this quote
          </a>
          <div style="font-size:11px;color:#94a3b8;margin-top:10px;">
            Link expires in ${ACCEPT_TOKEN_TTL_DAYS} days.
          </div>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fafafa;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0"
                 style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
            <tr>
              <td style="font-size:14px;line-height:1.6;color:#1e293b;">${messageHtml}</td>
            </tr>
            <tr>
              <td style="padding-top:24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                       style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
                  <tr style="background:#f8fafc;">
                    <td colspan="2" style="padding:10px 14px;font-weight:600;color:#0f172a;">
                      Quote summary
                    </td>
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
                  ${
                    validUntil
                      ? `<tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Valid until</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${escapeHtml(validUntil)}</td>
                  </tr>`
                      : ""
                  }
                </table>
              </td>
            </tr>
            ${breakdownBlock}
            <tr>
              <td style="padding-top:16px;font-size:12px;color:#64748b;">
                Your full quote is attached as a PDF.
              </td>
            </tr>
            ${acceptBlock}
            <tr>
              <td style="padding-top:32px;border-top:1px solid #f1f5f9;margin-top:24px;font-size:11px;color:#94a3b8;text-align:center;">
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  // Parse once, used by both happy path and audit-log failure writes.
  let body: Record<string, unknown> = {};
  let callerId: string | null = null;
  let serviceClient: ReturnType<typeof createClient> | null = null;
  let quoteId: string | null = null;

  try {
    // 1. JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ success: false, error: "Missing authorization" }, 401);
    }
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: authError,
    } = await anonClient.auth.getUser();
    if (authError || !caller) {
      return jsonResponse({ success: false, error: "Invalid token" }, 401);
    }
    callerId = caller.id;

    // 2. Permission check (service role)
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile, error: profileErr } = await serviceClient
      .from("staff_profiles")
      .select("id, name, email, can_approve_quotes")
      .eq("id", caller.id)
      .single();
    if (profileErr || !callerProfile) {
      return jsonResponse(
        { success: false, error: "Staff profile not found" },
        403,
      );
    }
    if (!callerProfile.can_approve_quotes) {
      return jsonResponse(
        { success: false, error: "Not authorised to send quotes" },
        403,
      );
    }

    // 3. Parse body (accept both camel and snake case for resilience)
    body = await req.json().catch(() => ({}));
    quoteId = (body.quote_id as string) || (body.quoteId as string) || null;
    const to = body.to as string | undefined;
    const ccRaw = body.cc as string[] | string | undefined;
    const cc = Array.isArray(ccRaw)
      ? ccRaw.filter(Boolean)
      : typeof ccRaw === "string" && ccRaw.trim()
        ? [ccRaw.trim()]
        : [];
    const subject = body.subject as string | undefined;
    const messageText = (body.message as string | undefined) || "";
    const pdfBase64 =
      (body.pdfBase64 as string | undefined) ||
      (body.pdf_base64 as string | undefined) ||
      null;
    const explicitFilename = body.filename as string | undefined;
    const includeAcceptLink =
      body.include_accept_link === undefined
        ? true
        : Boolean(body.include_accept_link);

    if (!quoteId) {
      return jsonResponse(
        { success: false, error: "quote_id is required" },
        400,
      );
    }
    if (!to || !subject) {
      return jsonResponse(
        { success: false, error: "to and subject are required" },
        400,
      );
    }

    // 4. Fetch quote + line items (line items drive the email breakdown
    //    table — same data the PDF uses).
    const [
      { data: quote, error: quoteErr },
      { data: lineItemsRaw, error: lineItemsErr },
    ] = await Promise.all([
      serviceClient
        .from("quotes")
        .select(
          "id, quote_ref, status, monthly_gross, annual_total, relationship_group, valid_until, entity_id",
        )
        .eq("id", quoteId)
        .single(),
      serviceClient
        .from("quote_line_items")
        .select("description, annual_amount, is_recurring, service_id, sort_order")
        .eq("quote_id", quoteId)
        .order("sort_order"),
    ]);
    if (quoteErr || !quote) {
      return jsonResponse({ success: false, error: "Quote not found" }, 404);
    }
    // Line items are optional — if the fetch errored we still want to send
    // the email (with headline summary only). Log but don't fail.
    if (lineItemsErr) {
      console.error(
        "[send-quote-email] line items fetch failed",
        lineItemsErr,
      );
    }
    const lineItems = (lineItemsRaw ?? []) as unknown as LineItem[];

    // 5. Status guard
    if (!["approved", "sent"].includes(quote.status)) {
      return jsonResponse(
        {
          success: false,
          error: `Quote status must be approved or sent (current: ${quote.status})`,
        },
        400,
      );
    }

    // 6. Accept link — bind the recipient email into the token so it can be
    //    recorded verbatim on acceptance (non-repudiation, phase 1).
    let acceptUrl: string | null = null;
    if (includeAcceptLink) {
      const token = await signAcceptToken({
        quoteId: quote.id,
        recipientEmail: to,
      });
      acceptUrl = `${PORTAL_PUBLIC_URL}/accept-quote?token=${encodeURIComponent(token)}`;
    }

    // 7. Build HTML
    const messageHtml = escapeHtml(messageText).replace(/\n/g, "<br>");
    const html = renderEmailHtml({ messageHtml, quote, lineItems, acceptUrl });

    // 8. Build Resend payload
    const filename = (explicitFilename || `${quote.quote_ref || "quote"}.pdf`)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const resendPayload: Record<string, unknown> = {
      from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
    };
    if (cc.length) resendPayload.cc = cc;
    if (pdfBase64) {
      resendPayload.attachments = [
        { filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`, content: pdfBase64 },
      ];
    }

    // 9. Send via Resend
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(resendPayload),
    });
    const resendJson = await resendResp.json().catch(() => ({}));

    if (!resendResp.ok) {
      console.error("[send-quote-email] Resend error", resendResp.status, resendJson);
      // audit log failure
      await serviceClient.from("audit_log").insert({
        user_id: caller.id,
        action: "send-quote-email-failed",
        entity_type: "quote",
        entity_id: quote.id,
        detail: {
          stage: "resend_api",
          status: resendResp.status,
          error: resendJson?.message || resendJson,
          recipient: to,
        },
      });
      return jsonResponse(
        {
          success: false,
          error:
            resendJson?.message || `Resend API error (${resendResp.status})`,
        },
        502,
      );
    }

    const resendId = (resendJson?.id as string) || null;
    const sentAt = new Date().toISOString();

    // 10. Update quote row
    const { error: updateErr } = await serviceClient
      .from("quotes")
      .update({ status: "sent", sent_at: sentAt })
      .eq("id", quote.id);
    if (updateErr) {
      // Email sent but DB update failed. Record it — manual reconciliation.
      console.error("[send-quote-email] quote update failed after send", updateErr);
      await serviceClient.from("audit_log").insert({
        user_id: caller.id,
        action: "send-quote-email-partial",
        entity_type: "quote",
        entity_id: quote.id,
        detail: {
          stage: "post_send_update",
          error: updateErr.message,
          resend_id: resendId,
          recipient: to,
        },
      });
      return jsonResponse(
        {
          success: true,
          warning:
            "Email sent but quote status update failed — needs manual reconcile",
          resend_id: resendId,
          quote_id: quote.id,
          sent_at: sentAt,
        },
        200,
      );
    }

    // 11. Audit log success
    await serviceClient.from("audit_log").insert({
      user_id: caller.id,
      action: "sent_to_client",
      entity_type: "quote",
      entity_id: quote.id,
      detail: {
        recipient: to,
        cc,
        subject,
        resend_id: resendId,
        had_pdf: Boolean(pdfBase64),
        had_accept_link: Boolean(acceptUrl),
      },
    });

    return jsonResponse({
      success: true,
      resend_id: resendId,
      quote_id: quote.id,
      sent_at: sentAt,
    });
  } catch (err) {
    console.error("[send-quote-email] Unhandled error", err);
    // Best-effort audit log — only if we got far enough to know caller + quote
    if (serviceClient && callerId) {
      try {
        await serviceClient.from("audit_log").insert({
          user_id: callerId,
          action: "send-quote-email-failed",
          entity_type: "quote",
          entity_id: quoteId,
          detail: {
            stage: "unhandled",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (_) {
        /* swallow — already in failure path */
      }
    }
    return jsonResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
