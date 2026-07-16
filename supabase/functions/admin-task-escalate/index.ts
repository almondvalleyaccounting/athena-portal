// admin-task-escalate — Athena Portal
// Sophie (or any staff) escalates an admin task: pick who should action it and
// send them an email. Records the escalation on the task + drops a note on the
// thread. Invoked from the Admin task list with the caller's JWT.
//
// Body: { task_id, to_staff_id, note?, dry_run?, test_recipient? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Auth: active-staff JWT (this is always user-invoked).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: caller } = await service.from("staff_profiles").select("id, name, is_active").eq("id", user.id).single();
  if (!caller?.is_active) return json({ success: false, error: "Not authorised" }, 403);

  const body = await req.json().catch(() => ({}));
  const taskId: string = body.task_id;
  const toStaffId: string = body.to_staff_id;
  const note: string = (body.note || "").trim();
  const dryRun = body.dry_run === true;
  const testRecipient: string | null = body.test_recipient || null;
  if (!taskId || !toStaffId) return json({ success: false, error: "task_id and to_staff_id required" }, 400);

  const [{ data: task }, { data: target }] = await Promise.all([
    service.from("admin_tasks").select("id, title, value, field, deadline, entity:entities(name)").eq("id", taskId).single(),
    service.from("staff_profiles").select("id, name, email, is_active").eq("id", toStaffId).single(),
  ]);
  if (!task) return json({ success: false, error: "task not found" }, 404);
  if (!target?.email || target.is_active === false) return json({ success: false, error: "target has no email / inactive" }, 400);

  const to = testRecipient || (target.email as string);
  const client = (task.entity as { name?: string } | null)?.name;
  const title = task.title as string;
  const deadline = task.deadline
    ? new Date(task.deadline + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : null;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:4px;">Action needed on an admin task</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#1e293b;">${esc(caller.name || "A colleague")} has asked you to action this${client ? ` for <strong>${esc(client)}</strong>` : ""}:</td></tr>
        <tr><td style="padding-top:12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;">
            <tr><td style="padding:12px 14px;font-size:14px;font-weight:600;color:#0f172a;">${esc(title)}</td></tr>
            ${task.value ? `<tr><td style="padding:0 14px 10px;font-size:13px;color:#475569;">Value: <span style="font-family:monospace;">${esc(task.value)}</span></td></tr>` : ""}
            ${deadline ? `<tr><td style="padding:0 14px 12px;font-size:13px;color:#b45309;">Deadline: ${esc(deadline)}</td></tr>` : ""}
          </table>
        </td></tr>
        ${note ? `<tr><td style="padding-top:14px;font-size:14px;line-height:1.6;color:#1e293b;"><strong>Note:</strong> ${esc(note)}</td></tr>` : ""}
        <tr><td style="padding:20px 0 4px;">
          <a href="${PORTAL_URL}/admin/tasks" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open the admin task list</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Admin task escalation</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const text = `${caller.name || "A colleague"} has asked you to action this admin task${client ? ` for ${client}` : ""}:\n\n${title}${task.value ? `\nValue: ${task.value}` : ""}${deadline ? `\nDeadline: ${deadline}` : ""}${note ? `\n\nNote: ${note}` : ""}\n\nOpen the admin task list: ${PORTAL_URL}/admin/tasks`;

  if (dryRun) return json({ success: true, dry_run: true, to, task: title });

  const r = await sendEmail({ to, subject: `Action needed: ${title}`, html, text });
  if (!r.ok) return json({ success: false, error: r.error, resend_id: r.id }, 502);

  // Record escalation on the task + drop a note on the thread.
  await service.from("admin_tasks").update({
    escalated_to: toStaffId,
    escalated_at: new Date().toISOString(),
    escalation_note: note || null,
  }).eq("id", taskId);
  await service.from("admin_task_notes").insert({
    task_id: taskId,
    author_id: caller.id,
    kind: "escalation",
    body: `Escalated to ${target.name}${note ? `: ${note}` : ""}`,
  });

  return json({ success: true, to, escalated_to: target.name, resend_id: r.id });
});
