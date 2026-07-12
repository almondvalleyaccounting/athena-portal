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
  signGroupAcceptToken,
  ACCEPT_TOKEN_TTL_DAYS,
} from "../_shared/accept-token.ts";
import {
  escapeHtml,
  formatDateGB,
  formatGBP,
  GroupCompany,
  LineItem,
  renderBreakdownHtml,
  renderGroupBreakdownHtml,
} from "../_shared/email-format.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL =
  Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
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

// Group quote email — headline shows group totals; the breakdown is by
// company, by service; one accept link covers every company in the group.
function renderGroupEmailHtml(opts: {
  messageHtml: string;
  groupName: string;
  groupRef: string;
  monthlyGross: number;
  annualTotal: number;
  companies: GroupCompany[];
  acceptUrl: string | null;
  validUntil: string | null;
}): string {
  const { messageHtml, groupName, groupRef, monthlyGross, annualTotal, companies, acceptUrl, validUntil } = opts;
  const breakdownBlock = renderGroupBreakdownHtml(companies);
  const validUntilStr = formatDateGB(validUntil);

  const acceptBlock = acceptUrl
    ? `
      <tr>
        <td style="padding:24px 0 0 0;">
          <a href="${escapeHtml(acceptUrl)}"
             style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;
                    padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;
                    font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
            Review &amp; accept all ${companies.length} ${companies.length === 1 ? "company" : "companies"}
          </a>
          <div style="font-size:11px;color:#94a3b8;margin-top:10px;">
            Accepting confirms the quote for every company in the group. Link expires in ${ACCEPT_TOKEN_TTL_DAYS} days.
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
                      Group quote summary
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Reference</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${escapeHtml(groupRef)}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Group</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${escapeHtml(groupName)}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Companies</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${companies.length}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Total monthly DD (inc VAT)</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;font-weight:600;">${formatGBP(monthlyGross)}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Total annual (inc VAT)</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${formatGBP(annualTotal)}</td>
                  </tr>
                  ${
                    validUntilStr
                      ? `<tr>
                    <td style="padding:10px 14px;color:#64748b;border-top:1px solid #f1f5f9;">Valid until</td>
                    <td style="padding:10px 14px;color:#0f172a;border-top:1px solid #f1f5f9;text-align:right;">${escapeHtml(validUntilStr)}</td>
                  </tr>`
                      : ""
                  }
                </table>
              </td>
            </tr>
            ${breakdownBlock}
            <tr>
              <td style="padding-top:16px;font-size:12px;color:#64748b;">
                Your full group quote is attached as a PDF.
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

    // ── Group send branch ───────────────────────────────────────────────
    // When a group_id is supplied, the email summarises the whole group
    // (by company, by service), attaches the supplied group PDF, and the
    // accept link covers EVERY member quote in one click.
    const groupId = (body.group_id as string) || null;
    if (groupId) {
      if (!to || !subject) {
        return jsonResponse({ success: false, error: "to and subject are required" }, 400);
      }
      const { data: groupRow } = await serviceClient
        .from("billing_groups").select("id, name").eq("id", groupId).single();
      const { data: groupQuotes, error: gqErr } = await serviceClient
        .from("quotes")
        .select("id, quote_ref, status, monthly_gross, annual_total, relationship_group, valid_until")
        .eq("group_id", groupId)
        .neq("status", "deleted")
        .order("created_at");
      if (gqErr) return jsonResponse({ success: false, error: gqErr.message }, 500);
      // Don't touch quotes already committed to live.
      const sendable = (groupQuotes ?? []).filter((q) => q.status !== "committed");
      if (sendable.length === 0) {
        return jsonResponse({ success: false, error: "No sendable quotes in this group" }, 400);
      }
      const quoteIds = sendable.map((q) => q.id as string);

      const { data: allItems, error: itemsErr } = await serviceClient
        .from("quote_line_items")
        .select("quote_id, description, annual_amount, is_recurring, service_id, sort_order")
        .in("quote_id", quoteIds)
        .order("sort_order");
      if (itemsErr) console.error("[send-quote-email] group line items fetch failed", itemsErr);
      const itemsByQuote: Record<string, LineItem[]> = {};
      for (const it of (allItems ?? []) as Array<Record<string, unknown>>) {
        const qid = it.quote_id as string;
        (itemsByQuote[qid] ||= []).push(it as unknown as LineItem);
      }
      const companies: GroupCompany[] = sendable.map((q) => ({
        name: (q.relationship_group as string) || (q.quote_ref as string) || "Company",
        lineItems: itemsByQuote[q.id as string] || [],
      }));

      const groupName = (body.group_name as string) || (groupRow?.name as string) || "Group";
      const groupRef = (body.group_ref as string) || groupName;
      const monthlyGross = sendable.reduce((s, q) => s + (Number(q.monthly_gross) || 0), 0);
      const annualTotal = sendable.reduce((s, q) => s + (Number(q.annual_total) || 0), 0);
      // Earliest valid_until across the group is the binding one.
      const validUntil = sendable
        .map((q) => q.valid_until as string | null)
        .filter(Boolean)
        .sort()[0] || null;

      let acceptUrl: string | null = null;
      if (includeAcceptLink) {
        const token = await signGroupAcceptToken({ groupId, quoteIds, recipientEmail: to });
        acceptUrl = `${PORTAL_PUBLIC_URL}/accept-quote?token=${encodeURIComponent(token)}`;
      }

      const messageHtml = escapeHtml(messageText).replace(/\n/g, "<br>");
      const html = renderGroupEmailHtml({ messageHtml, groupName, groupRef, monthlyGross, annualTotal, companies, acceptUrl, validUntil });

      const filename = (explicitFilename || `${groupRef || "group-quote"}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
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

      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify(resendPayload),
      });
      const resendJson = await resendResp.json().catch(() => ({}));
      if (!resendResp.ok) {
        console.error("[send-quote-email] Resend error (group)", resendResp.status, resendJson);
        await serviceClient.from("audit_log").insert({
          user_id: caller.id, action: "send-quote-email-failed", entity_type: "billing_group", entity_id: groupId,
          detail: { stage: "resend_api", status: resendResp.status, error: resendJson?.message || resendJson, recipient: to },
        });
        return jsonResponse({ success: false, error: resendJson?.message || `Resend API error (${resendResp.status})` }, 502);
      }
      const resendId = (resendJson?.id as string) || null;
      const sentAt = new Date().toISOString();

      // Mark member quotes sent (only those awaiting a send — never un-accept
      // an already-accepted member). The accept token still covers all of them.
      const toMarkSent = sendable.filter((q) => q.status === "approved" || q.status === "sent").map((q) => q.id as string);
      if (toMarkSent.length) {
        const { error: upErr } = await serviceClient.from("quotes").update({ status: "sent", sent_at: sentAt }).in("id", toMarkSent);
        if (upErr) {
          console.error("[send-quote-email] group status update failed after send", upErr);
          await serviceClient.from("audit_log").insert({
            user_id: caller.id, action: "send-quote-email-partial", entity_type: "billing_group", entity_id: groupId,
            detail: { stage: "post_send_update", error: upErr.message, resend_id: resendId, recipient: to },
          });
          return jsonResponse({ success: true, warning: "Email sent but group status update failed — needs manual reconcile", resend_id: resendId, group_id: groupId, sent_at: sentAt }, 200);
        }
      }

      await serviceClient.from("audit_log").insert({
        user_id: caller.id, action: "sent_to_client_group", entity_type: "billing_group", entity_id: groupId,
        detail: { recipient: to, cc, subject, resend_id: resendId, companies: companies.length, quote_ids: quoteIds, had_pdf: Boolean(pdfBase64), had_accept_link: Boolean(acceptUrl) },
      });

      return jsonResponse({ success: true, resend_id: resendId, group_id: groupId, sent_count: quoteIds.length, sent_at: sentAt });
    }

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
