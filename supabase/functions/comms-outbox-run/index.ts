// comms-outbox-run — Athena Portal
// Sends emails from comms_outbox (sql/364) once they are due: Send later, and
// any undo-window email whose tab closed before it sent it.
//
// Called every minute by pg_cron (run_comms_outbox, only when something is
// due) with x-cron-secret = comms_outbox_config.cron_secret. Deployed with
// verify_jwt OFF; the secret check below is the only door, so there is no
// user path in.
//
// Each email goes out as the person who wrote it, from the mailbox they wrote
// it in, after re-checking that they're still active staff, still allowed
// that mailbox, and still under the outside-recipient cap (warnings were
// answered when it was queued).

import {
  getValidGmailToken, jsonResponse, corsHeaders, getServiceClient,
} from "../_shared/gmail-client.ts";
import { checkSend, sendEmail, type SendPayload } from "../_shared/gmail-send.ts";

const BATCH = 25;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  const service = getServiceClient();
  const { data: cfg } = await service.from("comms_outbox_config").select("cron_secret, enabled").eq("id", true).maybeSingle();
  const secret = req.headers.get("x-cron-secret") || "";
  if (!cfg?.cron_secret || !secret || secret !== cfg.cron_secret) {
    return jsonResponse({ success: false, error: "Not authorised" }, 401);
  }
  if (!cfg.enabled) return jsonResponse({ success: true, skipped: "disabled" });

  // A row claimed but never finished (the function died mid-send) — say so
  // rather than send it twice. The sender can check Sent and resend.
  await service.from("comms_outbox")
    .update({ status: "failed", error: "Interrupted while sending — check Sent before sending again." })
    .eq("status", "sending").lt("claimed_at", new Date(Date.now() - 10 * 60_000).toISOString());

  const { data: due } = await service.from("comms_outbox")
    .select("id").eq("status", "queued").lte("send_at", new Date().toISOString())
    .order("send_at").limit(BATCH);

  let sent = 0;
  let failed = 0;
  for (const { id } of due || []) {
    // Claim it first, so the tab's own "send now" and this can't both send it.
    const { data: row } = await service.from("comms_outbox")
      .update({ status: "sending", claimed_at: new Date().toISOString() })
      .eq("id", id).eq("status", "queued")
      .select("id, staff_id, mailbox, payload").maybeSingle();
    if (!row) continue;
    try {
      const { data: prof } = await service.from("staff_profiles")
        .select("is_active, is_portal_admin").eq("id", row.staff_id).maybeSingle();
      if (!prof?.is_active) throw new Error("The sender is no longer active staff.");
      const tok = await getValidGmailToken(row.mailbox);
      if (tok.kind === "personal" && tok.ownerStaffId !== row.staff_id && !prof.is_portal_admin) {
        throw new Error("The sender can no longer use this mailbox.");
      }
      const p = row.payload as SendPayload;
      const check = await checkSend(service, { mailbox: tok.accountEmail, to: p.to, cc: p.cc, bcc: p.bcc });
      if (check.blocked) throw new Error(check.blocked);
      const res = await sendEmail(tok, service, row.staff_id, p, "outbox");
      await service.from("comms_outbox").update({
        status: "sent", sent_at: new Date().toISOString(),
        gmail_message_id: res.id, gmail_thread_id: res.threadId,
      }).eq("id", row.id);
      sent++;
    } catch (e) {
      failed++;
      await service.from("comms_outbox")
        .update({ status: "failed", error: (e as Error).message.slice(0, 500) }).eq("id", row.id);
    }
  }
  return jsonResponse({ success: true, sent, failed });
});
